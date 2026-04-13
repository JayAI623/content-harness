# Fix All Critical + Important Issues — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every Critical (C1-C3) and Important (I1-I7) finding from the 2026-04-12 code-reviewer audit of the content-harness repo.

**Architecture:** Work bottom-up in six phases, each landing as its own commit(s). Start with isolated quick wins (exhaustiveness + missing-handler guard + applyPatch hardening), then the livelock + retry fixes, then domain-boundary validation, then the `GateResolver` generic refactor, and finish with the crash-safe persistence + `resumeRun` API. Every behavioural change is driven by a failing test first.

**Tech Stack:** TypeScript, vitest, pnpm workspace (`packages/harness-core`, `packages/social-pipeline`), node:fs/promises. No new dependencies.

---

## File Map

**New files**
- `packages/harness-core/src/patch.ts` — extracted `applyPatch` / `applyDelta` (Phase 1, reused Phase 2)
- `packages/harness-core/tests/patch.test.ts` — C3 + I1 coverage against real social-pipeline patch shapes
- `packages/harness-core/src/persistence-atomic.ts` — `writeAtomic`, `fsyncFile` helpers (Phase 6)
- `packages/harness-core/tests/resume.test.ts` — Phase 6 resume API + crash scenarios

**Modified files**
- `packages/harness-core/src/loop.ts` — moves `applyPatch` out, adds never-check, missing-handler guard, livelock guard, step counter threading, uses `RunConfig<TK, S>`
- `packages/harness-core/src/persistence.ts` — `snapshot` accepts explicit `step`, writes via `writeAtomic`, `appendEvent` uses O_SYNC fd, `loadLatestState` / `loadLatestPlan` gain consistency checks, new `resumeRun(runDir)`
- `packages/harness-core/src/retry.ts` — cost accumulation across attempts
- `packages/harness-core/src/types.ts` — `GateResolver<TK, S>`, `RunConfig<TK, S>`, `PlanContext<TK, S>` (or revert — see Phase 5 decision), `never`-check helper type for verdicts
- `packages/harness-core/src/gates.ts` — resolver implementations typed through new generic
- `packages/harness-core/src/index.ts` — export `resumeRun`, `EventEntry` step field, `applyPatch` (for tests)
- `packages/harness-core/src/planner.ts` — no functional change; add `hasFailed(plan)` helper used by livelock guard
- `packages/harness-core/tests/loop.test.ts` — I2, I5, I6 tests
- `packages/harness-core/tests/retry.test.ts` — I4 tests
- `packages/harness-core/tests/persistence.test.ts` — C1, C2 round-trip + crash tests
- `packages/social-pipeline/src/domain.ts` — I7: zod validation at `initState`, pass TK through `RunConfig` generic
- `packages/social-pipeline/tests/domain.test.ts` (or a new `tests/init-state.test.ts`) — I7 coverage

**Untouched**
- `packages/harness-core/src/budget.ts`, `packages/harness-core/src/infra/*` — not in scope
- The `tests/**` tsconfig exclusion (known backlog item; belongs in its own sprint)
- Social-pipeline handlers — not in scope

---

## Phase 1 — applyPatch Hardening (C3 + I1)

### Task 1: Extract `applyPatch` / `applyDelta` to `patch.ts`

**Files:**
- Create: `packages/harness-core/src/patch.ts`
- Modify: `packages/harness-core/src/loop.ts:1-48`
- Modify: `packages/harness-core/src/index.ts`

- [ ] **Step 1: Write a placeholder test asserting the module exists**

```ts
// packages/harness-core/tests/patch.test.ts
import { describe, it, expect } from "vitest";
import { applyPatch, applyDelta } from "../src/patch.js";
import type { StatePatch } from "../src/types.js";

describe("applyPatch", () => {
  it("exports applyPatch and applyDelta", () => {
    expect(typeof applyPatch).toBe("function");
    expect(typeof applyDelta).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/harness-core test -- patch.test.ts`
Expected: FAIL — `Cannot find module '../src/patch.js'`.

- [ ] **Step 3: Create `patch.ts` with the code lifted from `loop.ts`**

```ts
// packages/harness-core/src/patch.ts
import type { Delta, StatePatch } from "./types.js";

export function applyPatch<S>(state: S, patch: StatePatch): S {
  if (patch.path.length === 0) {
    return patch.value as S;
  }
  const copy: any = Array.isArray(state) ? [...(state as any)] : { ...(state as any) };
  let cursor: any = copy;
  for (let i = 0; i < patch.path.length - 1; i++) {
    const k = patch.path[i]!;
    cursor[k] = Array.isArray(cursor[k]) ? [...cursor[k]] : { ...(cursor[k] ?? {}) };
    cursor = cursor[k];
  }
  const last = patch.path[patch.path.length - 1]!;
  switch (patch.op) {
    case "set":
      cursor[last] = patch.value;
      break;
    case "append": {
      const arr = Array.isArray(cursor[last]) ? [...cursor[last]] : [];
      arr.push(patch.value);
      cursor[last] = arr;
      break;
    }
    case "merge":
      cursor[last] = { ...(cursor[last] ?? {}), ...(patch.value as object) };
      break;
  }
  return copy as S;
}

export function applyDelta<S>(state: S, delta: Delta<S>): S {
  let next = state;
  for (const p of delta.patches) next = applyPatch(next, p);
  return next;
}
```

- [ ] **Step 4: Update `loop.ts` to import from `./patch.js`**

Replace `loop.ts:1-48` so the `applyPatch` / `applyDelta` bodies are gone and the top of file becomes:

```ts
import { Budget } from "./budget.js";
import { applyDelta } from "./patch.js";
import { appendEvent, createRun, snapshot } from "./persistence.js";
import { markCompleted, markFailed, markRevise, selectNextRunnable, markRejected } from "./planner.js";
import { runWithRetry } from "./retry.js";
import type {
  Delta,
  HarnessDomain,
  InfraBundle,
  RunConfig,
  RunResult,
  WorkPlan,
} from "./types.js";
```

(Note: `StatePatch` import removed from `loop.ts` — now only used in `patch.ts`.)

- [ ] **Step 5: Re-export `applyPatch` from `index.ts` (test-only entry point is fine)**

Append to `packages/harness-core/src/index.ts`:

```ts
export { applyPatch, applyDelta } from "./patch.js";
```

- [ ] **Step 6: Run all harness-core tests**

Run: `pnpm -C packages/harness-core test`
Expected: **PASS** — all 43 existing tests + the new placeholder test green (44 total).

Run: `pnpm -C packages/harness-core typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/harness-core/src/patch.ts \
        packages/harness-core/src/loop.ts \
        packages/harness-core/src/index.ts \
        packages/harness-core/tests/patch.test.ts
git commit -m "refactor(core): extract applyPatch to its own module"
```

---

### Task 2: Fix C3 — `applyPatch` must `structuredClone` the incoming value

**Files:**
- Modify: `packages/harness-core/src/patch.ts`
- Modify: `packages/harness-core/tests/patch.test.ts`

- [ ] **Step 1: Write the failing aliasing test**

Add to `tests/patch.test.ts`:

```ts
describe("applyPatch — no aliasing", () => {
  it("does not alias the patch value into state (set op)", () => {
    const shared = { nested: { n: 1 } };
    const state = { a: { b: null as { nested: { n: number } } | null } };
    const next = applyPatch(state, { op: "set", path: ["a", "b"], value: shared });
    shared.nested.n = 999;
    expect((next.a.b as { nested: { n: number } }).nested.n).toBe(1);
  });

  it("does not alias the patch value into state (merge op)", () => {
    const shared = { inner: { x: 1 } };
    const state = { meta: {} as Record<string, unknown> };
    const next = applyPatch(state, { op: "merge", path: ["meta"], value: { extra: shared } });
    shared.inner.x = 999;
    expect((next.meta as { extra: { inner: { x: number } } }).extra.inner.x).toBe(1);
  });

  it("does not alias the patch value into state (append op)", () => {
    const shared = { label: "hello" };
    const state = { items: [] as Array<{ label: string }> };
    const next = applyPatch(state, { op: "append", path: ["items"], value: shared });
    shared.label = "mutated";
    expect(next.items[0]!.label).toBe("hello");
  });
});
```

- [ ] **Step 2: Run tests — expect all three to fail**

Run: `pnpm -C packages/harness-core test -- patch.test.ts`
Expected: 3 failures, each showing `expected 999 to be 1` or `"mutated" to be "hello"`.

- [ ] **Step 3: Implement the fix — clone `patch.value` once at the top of `applyPatch`**

Edit `patch.ts` `applyPatch`:

```ts
export function applyPatch<S>(state: S, patch: StatePatch): S {
  const value = structuredClone(patch.value);
  if (patch.path.length === 0) {
    return value as S;
  }
  const copy: any = Array.isArray(state) ? [...(state as any)] : { ...(state as any) };
  let cursor: any = copy;
  for (let i = 0; i < patch.path.length - 1; i++) {
    const k = patch.path[i]!;
    cursor[k] = Array.isArray(cursor[k]) ? [...cursor[k]] : { ...(cursor[k] ?? {}) };
    cursor = cursor[k];
  }
  const last = patch.path[patch.path.length - 1]!;
  switch (patch.op) {
    case "set":
      cursor[last] = value;
      break;
    case "append": {
      const arr = Array.isArray(cursor[last]) ? [...cursor[last]] : [];
      arr.push(value);
      cursor[last] = arr;
      break;
    }
    case "merge":
      cursor[last] = { ...(cursor[last] ?? {}), ...(value as object) };
      break;
  }
  return copy as S;
}
```

- [ ] **Step 4: Run tests — expect all green**

Run: `pnpm -C packages/harness-core test -- patch.test.ts`
Expected: PASS.

Run: `pnpm -C packages/harness-core test` (full suite)
Expected: 44/44 PASS (no regression in loop/persistence/etc.).

- [ ] **Step 5: Commit**

```bash
git add packages/harness-core/src/patch.ts packages/harness-core/tests/patch.test.ts
git commit -m "fix(core): structuredClone patch.value in applyPatch to prevent aliasing"
```

---

### Task 3: I1 — Cover the real social-pipeline patch shapes

**Files:**
- Modify: `packages/harness-core/tests/patch.test.ts`

- [ ] **Step 1: Write a test using the exact shape `eval_variant.ts` emits**

Add to `tests/patch.test.ts`:

```ts
describe("applyPatch — social-pipeline patch shapes", () => {
  it("handles nested array index as string (eval_variant path)", () => {
    const state = {
      piece: {
        platform_variants: [
          { platform: "x", status: "draft", score: null as number | null },
          { platform: "ig", status: "draft", score: null as number | null },
        ],
      },
    };
    const next = applyPatch(state, {
      op: "set",
      path: ["piece", "platform_variants", "0", "status"],
      value: "accepted",
    });
    expect(next.piece.platform_variants[0]!.status).toBe("accepted");
    expect(next.piece.platform_variants[1]!.status).toBe("draft");
    // Structural share check — state untouched
    expect(state.piece.platform_variants[0]!.status).toBe("draft");
  });

  it("append into a nested array creates a new array reference", () => {
    const state = { piece: { platform_variants: [{ platform: "x" }] as Array<{ platform: string }> } };
    const next = applyPatch(state, {
      op: "append",
      path: ["piece", "platform_variants"],
      value: { platform: "ig" },
    });
    expect(next.piece.platform_variants).toHaveLength(2);
    expect(state.piece.platform_variants).toHaveLength(1);
    expect(next.piece.platform_variants).not.toBe(state.piece.platform_variants);
  });

  it("merge into a missing nested field creates it", () => {
    const state = { piece: {} as { meta?: Record<string, unknown> } };
    const next = applyPatch(state, {
      op: "merge",
      path: ["piece", "meta"],
      value: { k: "v" },
    });
    expect(next.piece.meta).toEqual({ k: "v" });
  });
});
```

- [ ] **Step 2: Run — expect all PASS immediately**

Run: `pnpm -C packages/harness-core test -- patch.test.ts`
Expected: PASS. (These are regression guards, not fix-driven. They document the currently-correct behaviour so that future changes to `applyPatch` can't silently break the social domain's runtime shape.)

- [ ] **Step 3: Commit**

```bash
git add packages/harness-core/tests/patch.test.ts
git commit -m "test(core): guard applyPatch against real social-pipeline patch shapes"
```

---

## Phase 2 — Verdict Exhaustiveness + Missing-Handler Guard (I2 + I6)

### Task 4: I2 — `never`-exhaustive check on the verdict switch

**Files:**
- Modify: `packages/harness-core/src/loop.ts:137-154`
- Modify: `packages/harness-core/tests/loop.test.ts`

- [ ] **Step 1: Write the failing runtime test**

Add at the end of `tests/loop.test.ts`:

```ts
it("throws a clear error when evaluate returns an unknown verdict kind", async () => {
  const domain = makeTestDomain({
    // cast forces a bogus kind that the switch is not prepared for
    evaluate: async () => ({ kind: "sideways" } as unknown as Verdict),
  });
  await expect(run(domain, {}, defaultConfig(), infra, "d-test"))
    .rejects.toThrow(/unhandled verdict kind: sideways/);
});
```

(Use whatever test-domain factory `loop.test.ts` already has — reuse `makeTestDomain` if present; otherwise inline a minimal `HarnessDomain`.)

- [ ] **Step 2: Run — expect fail**

Run: `pnpm -C packages/harness-core test -- loop.test.ts`
Expected: FAIL — the current `switch` falls through silently and `run()` returns `{ok:true}` instead of throwing.

- [ ] **Step 3: Add the never-check `default` arm to the switch at `loop.ts:137`**

```ts
switch (verdict.kind) {
  case "continue":
    break;
  case "revise":
    plan = markRevise(plan, verdict.task_id, verdict.feedback);
    break;
  case "redirect":
    plan = await domain.replan({ state, config }, verdict.reason);
    break;
  case "done": {
    await snapshot(runDir, { state: domain.serializeState(state), plan, budget: budget.snapshot() });
    const rejection = await maybePrePublishReject(state, budget, runDir);
    if (rejection) return rejection;
    return { ok: true, state, budget: budget.snapshot(), run_dir: runDir };
  }
  case "abort":
    return { ok: false, state, budget: budget.snapshot(), reason: verdict.reason, run_dir: runDir };
  default: {
    const _exhaustive: never = verdict;
    throw new Error(`unhandled verdict kind: ${(_exhaustive as { kind: string }).kind}`);
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm -C packages/harness-core test -- loop.test.ts`
Expected: PASS.

Run: `pnpm -C packages/harness-core typecheck`
Expected: exit 0. The `never` assignment compiles because all five `Verdict` variants are covered.

- [ ] **Step 5: Commit**

```bash
git add packages/harness-core/src/loop.ts packages/harness-core/tests/loop.test.ts
git commit -m "fix(core): add never-exhaustive check to verdict switch"
```

---

### Task 5: I6 — Missing-handler guard in the main loop

**Files:**
- Modify: `packages/harness-core/src/loop.ts:111`
- Modify: `packages/harness-core/tests/loop.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/loop.test.ts`:

```ts
it("aborts cleanly when the plan has a task whose kind has no handler", async () => {
  const domain = makeTestDomain({
    planInitial: async () => ({
      plan_id: "p-ghost",
      piece_id: "piece-1",
      tasks: [{
        id: "t-ghost",
        kind: "not_a_real_kind" as any,
        params: {},
        deps: [],
        input_refs: [],
        acceptance_criteria: "",
        gate_before: false,
        gate_after: false,
        status: "pending" as const,
      }],
      budget_estimate: { tokens: 0, usd: 0, iterations: 0 },
    }),
  });
  const result = await run(domain, {}, defaultConfig(), infra, "d-test");
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/no handler for task kind "not_a_real_kind"/);
});
```

- [ ] **Step 2: Run — expect fail (TypeError leaks)**

Run: `pnpm -C packages/harness-core test -- loop.test.ts`
Expected: the test's `run()` rejects with `TypeError: handler is not a function` (or similar), not the shaped abort.

- [ ] **Step 3: Add the guard before `runWithRetry` at `loop.ts:111`**

```ts
const handler = domain.handlers[task.kind];
if (!handler) {
  return {
    ok: false,
    state,
    budget: budget.snapshot(),
    reason: `no handler for task kind "${task.kind}"`,
    run_dir: runDir,
  };
}
const delta = await runWithRetry(handler, task, state, infra, config.retry);
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm -C packages/harness-core test -- loop.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/harness-core/src/loop.ts packages/harness-core/tests/loop.test.ts
git commit -m "fix(core): guard against tasks whose kind has no registered handler"
```

---

## Phase 3 — Livelock Guard + Retry Cost Accumulation (I5 + I4)

### Task 6: I5 — Abort the loop when a failed task leaves no runnable successor

**Context for the implementer:** Today, a `draft_base` failure in the social pipeline marks the task `failed`; the next iteration has no runnable task (failed tasks don't match `pending`, dependents are blocked); `stuckChecks` climbs to 4 after three `replan()` rounds rebuild the identical plan; eventually the loop exits via the generic `no runnable task` path, but in the meantime it has burned iterations and budget on redundant replans. The fix: when `selectNextRunnable` returns null **and** the plan has any task in `failed` state, short-circuit immediately with a shaped reason so callers can tell "domain couldn't make progress" from "budget blew up".

**Files:**
- Modify: `packages/harness-core/src/planner.ts`
- Modify: `packages/harness-core/src/loop.ts:92-100`
- Modify: `packages/harness-core/tests/loop.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/loop.test.ts`:

```ts
it("aborts with a failed-task reason when a task failure leaves nothing runnable", async () => {
  const domain = makeTestDomain({
    planInitial: async () => ({
      plan_id: "p-1",
      piece_id: "piece-1",
      tasks: [
        {
          id: "t-root", kind: "boom" as any, params: {}, deps: [], input_refs: [],
          acceptance_criteria: "", gate_before: false, gate_after: false, status: "pending",
        },
        {
          id: "t-dep", kind: "noop" as any, params: {}, deps: ["t-root"], input_refs: [],
          acceptance_criteria: "", gate_before: false, gate_after: false, status: "pending",
        },
      ],
      budget_estimate: { tokens: 0, usd: 0, iterations: 0 },
    }),
    handlers: {
      boom: async () => ({
        kind: "failure",
        patches: [],
        cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
        error: { message: "boom", retryable: false },
      }),
      noop: async () => ({ kind: "success", patches: [], cost: { input_tokens: 0, output_tokens: 0, usd: 0 } }),
    } as any,
    // evaluate returns continue so the loop relies on selectNextRunnable to decide
    evaluate: async () => ({ kind: "continue" }),
    isDone: () => false,
  });
  const result = await run(domain, {}, defaultConfig({ budget: { max_iterations: 20 } }), infra, "d-test");
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/failed task/);
  // Crucially: budget.iterations should be 1 (the failing task), NOT 20 (budget exhausted)
  expect(result.budget.iterations).toBeLessThan(5);
});
```

- [ ] **Step 2: Run — expect fail**

Run: `pnpm -C packages/harness-core test -- loop.test.ts`
Expected: fail either because `result.reason` is `"no runnable task"` (not `/failed task/`) or because `iterations >= 5` (budget-burning replans).

- [ ] **Step 3: Add a `hasFailed` helper to `planner.ts`**

Append:

```ts
export function hasFailed<TK extends string>(plan: WorkPlan<TK>): Task<TK> | null {
  return plan.tasks.find((t) => t.status === "failed") ?? null;
}
```

Export it from `packages/harness-core/src/index.ts`:

```ts
export {
  selectNextRunnable,
  markCompleted,
  markFailed,
  markRevise,
  markRejected,
  hasFailed,
} from "./planner.js";
```

- [ ] **Step 4: Wire the guard into `loop.ts` at the `!task` branch (line 92)**

```ts
const task = selectNextRunnable(plan, state);
if (!task) {
  const failed = hasFailed(plan);
  if (failed) {
    return {
      ok: false,
      state,
      budget: budget.snapshot(),
      reason: `failed task "${failed.id}" has no recovery path`,
      run_dir: runDir,
    };
  }
  stuckChecks += 1;
  if (stuckChecks > 3) {
    return { ok: false, state, budget: budget.snapshot(), reason: "no runnable task", run_dir: runDir };
  }
  plan = await domain.replan({ state, config }, "no runnable task");
  continue;
}
```

Also add `import { ..., hasFailed } from "./planner.js";` to the top.

- [ ] **Step 5: Run tests — expect PASS + no regression**

Run: `pnpm -C packages/harness-core test`
Expected: all previous tests plus the new one PASS.

- [ ] **Step 6: Check social-pipeline still green**

Run: `pnpm -C packages/social-pipeline test`
Expected: 41/41 PASS. (The fix is strictly additive — social relies on `redirect` / `revise` paths, not on the generic stuck-recovery, so nothing should regress.)

- [ ] **Step 7: Commit**

```bash
git add packages/harness-core/src/planner.ts \
        packages/harness-core/src/loop.ts \
        packages/harness-core/src/index.ts \
        packages/harness-core/tests/loop.test.ts
git commit -m "fix(core): short-circuit livelock when failed task blocks all successors"
```

---

### Task 7: I4 — Accumulate handler cost across retry attempts

**Files:**
- Modify: `packages/harness-core/src/retry.ts`
- Modify: `packages/harness-core/tests/retry.test.ts`

- [ ] **Step 1: Write the failing cost-accumulation test**

Add to `tests/retry.test.ts`:

```ts
it("accumulates cost across retryable failure attempts", async () => {
  let attempt = 0;
  const handler: TaskHandler<{}> = async () => {
    attempt += 1;
    if (attempt < 3) {
      return {
        kind: "failure",
        patches: [],
        cost: { input_tokens: 10, output_tokens: 5, usd: 0.01 },
        error: { message: "transient", retryable: true },
      };
    }
    return {
      kind: "success",
      patches: [],
      cost: { input_tokens: 20, output_tokens: 10, usd: 0.02 },
    };
  };
  const delta = await runWithRetry(
    handler,
    makeTask(),
    {},
    fakeInfra(),
    { max_attempts: 5, backoff_ms: 0 },
  );
  expect(delta.kind).toBe("success");
  // 10+10+20 input, 5+5+10 output, 0.01+0.01+0.02 usd
  expect(delta.cost.input_tokens).toBe(40);
  expect(delta.cost.output_tokens).toBe(20);
  expect(delta.cost.usd).toBeCloseTo(0.04, 5);
});

it("returns the accumulated cost even when all retries fail", async () => {
  const handler: TaskHandler<{}> = async () => ({
    kind: "failure",
    patches: [],
    cost: { input_tokens: 7, output_tokens: 3, usd: 0.005 },
    error: { message: "flaky", retryable: true },
  });
  const delta = await runWithRetry(
    handler,
    makeTask(),
    {},
    fakeInfra(),
    { max_attempts: 3, backoff_ms: 0 },
  );
  expect(delta.kind).toBe("failure");
  expect(delta.cost.input_tokens).toBe(21);
  expect(delta.cost.output_tokens).toBe(9);
  expect(delta.cost.usd).toBeCloseTo(0.015, 5);
});
```

(Reuse any existing `makeTask` / `fakeInfra` helpers in `retry.test.ts`; if none exist, inline them at the top of the new describe block.)

- [ ] **Step 2: Run — expect fail**

Run: `pnpm -C packages/harness-core test -- retry.test.ts`
Expected: fail — current `runWithRetry` returns only the last attempt's cost.

- [ ] **Step 3: Implement cost accumulation**

Replace the body of `runWithRetry` in `packages/harness-core/src/retry.ts`:

```ts
import type { CostAccounting, Delta, InfraBundle, Task, TaskHandler } from "./types.js";
import { zeroCost } from "./types.js";

export interface RetryConfig {
  max_attempts: number;
  backoff_ms: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function addCost(a: CostAccounting, b: CostAccounting): CostAccounting {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    usd: a.usd + b.usd,
  };
}

export async function runWithRetry<S>(
  handler: TaskHandler<S>,
  task: Task<string>,
  state: S,
  infra: InfraBundle,
  config: RetryConfig,
): Promise<Delta<S>> {
  let attempt = 0;
  let lastFailure: Delta<S> | null = null;
  let accumulated: CostAccounting = zeroCost;

  while (attempt < config.max_attempts) {
    attempt += 1;
    try {
      const result = await handler(task, state, infra);
      accumulated = addCost(accumulated, result.cost);
      if (result.kind === "success") {
        return { ...result, cost: accumulated };
      }
      lastFailure = result;
      if (!result.error?.retryable) {
        return { ...result, cost: accumulated };
      }
    } catch (err) {
      lastFailure = {
        kind: "failure",
        patches: [],
        cost: zeroCost,
        error: { message: err instanceof Error ? err.message : String(err), retryable: true },
      };
      // Thrown errors produce no observable cost — accumulated is unchanged.
    }

    if (attempt < config.max_attempts && config.backoff_ms > 0) {
      await sleep(config.backoff_ms * attempt);
    }
  }

  if (lastFailure) {
    return { ...lastFailure, cost: accumulated };
  }
  return {
    kind: "failure",
    patches: [],
    cost: accumulated,
    error: { message: "no attempts made", retryable: false },
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `pnpm -C packages/harness-core test -- retry.test.ts`
Expected: new tests PASS, old retry tests still PASS.

Run: `pnpm -C packages/harness-core test` (full suite — guards against loop-level cost assertions drifting)
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/harness-core/src/retry.ts packages/harness-core/tests/retry.test.ts
git commit -m "fix(core): accumulate handler cost across retry attempts"
```

---

## Phase 4 — Domain Boundary Validation (I7)

### Task 8: I7 — Validate `initState` input with zod in social-pipeline

**Files:**
- Modify: `packages/social-pipeline/src/domain.ts:258-261`
- Create or modify: `packages/social-pipeline/tests/init-state.test.ts`

- [ ] **Step 1: Confirm the schema exports**

The schemas live in `packages/social-pipeline/src/schemas/persona.ts`, `campaign.ts`, and `piece.ts` and are re-exported from `packages/social-pipeline/src/schemas/index.ts`. They're the source of the inferred types currently imported at `domain.ts:16-20`. Open `schemas/index.ts` to confirm the exact export names (likely `PersonaSchema`, `CampaignSchema`, `PieceSchema`).

- [ ] **Step 2: Write the failing test**

Create `packages/social-pipeline/tests/init-state.test.ts`. Reuse the valid fixtures already defined inline at `tests/domain.test.ts:6-32` by copying them (short enough to duplicate, and the existing test doesn't export them):

```ts
import { describe, it, expect } from "vitest";
import { makeSocialDomain } from "../src/domain.js";
import { fakeOpencliClient } from "../src/opencli-client.js";
import { DEFAULT_EVALUATOR_PERSONAS } from "../src/eval/personas.js";

const persona = {
  id: "liu",
  identity: { name: "Liu", one_line_bio: "", long_bio: "" },
  voice: { tone: "analytic", point_of_view: "first-person", vocabulary: { prefer: [], avoid: [] }, example_phrases: [] },
  domain: { primary_topics: ["ai"], expertise_depth: "practitioner" as const, adjacent_topics: [] },
  audience: {
    description: "eng",
    pain_points: [],
    sophistication: "practitioner" as const,
    evaluator_persona_ids: DEFAULT_EVALUATOR_PERSONAS.map((p) => p.id),
  },
  platforms: [{ platform: "twitter" as const, handle: "liu", priority: 1, role: "primary" as const }],
  style_references: { emulate: [], avoid: [] },
  success_metrics: { primary: "engagement" as const, red_lines: [] },
  asset_pool_id: "liu",
};
const campaign = { id: "q2", persona_id: "liu", goal: "", timeline: { start: "2026-04-01T00:00:00Z" }, key_messages: [], content_mix: {}, overrides: {}, success_criteria: "" };
const piece = {
  id: "piece1",
  campaign_id: "q2",
  persona_id: "liu",
  input: { raw_materials: [{ id: "rm1", kind: "text" as const, content: "stuff", origin: "inline" }], intent: "ship" },
  state: "draft" as const,
  platform_variants: [],
  eval_history: [],
};

describe("socialDomain.initState", () => {
  const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });

  it("rejects input missing persona", () => {
    expect(() => domain.initState({ campaign, piece })).toThrow();
  });

  it("rejects input where persona is not an object", () => {
    expect(() => domain.initState({ persona: "not-a-persona", campaign, piece })).toThrow();
  });

  it("rejects piece with unknown variant status (schema enum breach)", () => {
    const badPiece = { ...piece, platform_variants: [{ platform: "twitter", status: "WAT", body: "", revision_count: 0 }] };
    expect(() => domain.initState({ persona, campaign, piece: badPiece })).toThrow();
  });

  it("accepts a fully valid input fixture", () => {
    expect(() => domain.initState({ persona, campaign, piece })).not.toThrow();
  });
});
```

- [ ] **Step 3: Run — expect fail (currently `initState` does `as` cast with no validation, so invalid input passes silently)**

Run: `pnpm -C packages/social-pipeline test -- init-state`
Expected: the two reject-path tests fail (no throw).

- [ ] **Step 4: Fix `initState` in `domain.ts:258`**

```ts
initState(input: unknown): SocialState {
  const parsed = z.object({
    persona: PersonaSchema,
    campaign: CampaignSchema,
    piece: PieceSchema,
  }).parse(input);
  return initSocialState(parsed);
},
```

Add `import { z } from "zod";` at the top of `domain.ts`, and import the three schemas from their existing module (likely `./schemas/index.js`).

- [ ] **Step 5: Run tests — expect PASS**

Run: `pnpm -C packages/social-pipeline test`
Expected: 41 prior + 3 new = 44 PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/social-pipeline/src/domain.ts \
        packages/social-pipeline/tests/init-state.test.ts
git commit -m "fix(social): validate initState input with zod at the domain boundary"
```

---

## Phase 5 — Typed `GateResolver<TK, S>` + `RunConfig<TK, S>` (I3)

**Scope note for the implementer:** this is the largest pure-type refactor in the plan. It touches `types.ts`, `gates.ts`, `loop.ts`, `index.ts`, and any place that constructs `RunConfig`. No runtime behaviour changes. The whole phase lands as **one** commit because partial application breaks compilation.

### Task 9: Parameterise `GateResolver`, `RunConfig`, `PlanContext` by `<TK, S>`

**Files:**
- Modify: `packages/harness-core/src/types.ts`
- Modify: `packages/harness-core/src/gates.ts`
- Modify: `packages/harness-core/src/loop.ts`
- Modify: `packages/harness-core/src/index.ts`
- Modify: call sites in `packages/social-pipeline/src/domain.ts`
- Modify: test utilities that construct `RunConfig` — likely `packages/harness-core/tests/loop.test.ts`, `tests/gates.test.ts`, and any social-pipeline test helpers.

- [ ] **Step 1: Inspect every `RunConfig` / `GateResolver` construction site**

Run: `Grep` for `RunConfig`, `GateResolver`, `PlanContext` across both packages.
Record the list. Every one of these will need to either (a) gain a concrete `<TK, S>`, or (b) use the default parameters you add.

- [ ] **Step 2: Update `types.ts`**

```ts
export interface GateResolver<TK extends string = string, S = unknown> {
  (event: GateEvent<TK, S>): Promise<GateDecision>;
}

export interface PlanContext<TK extends string, State> {
  state: State;
  config: RunConfig<TK, State>;
}

export interface RunConfig<TK extends string = string, S = unknown> {
  run_id: string;
  run_root: string;
  budget: BudgetLimits;
  retry: { max_attempts: number; backoff_ms: number };
  gates: {
    post_plan: boolean;
    pre_publish: boolean;
  };
  gate_resolver: GateResolver<TK, S>;
  thresholds: {
    eval_pass: number;
    ai_smell_max: number;
    depth_min: number;
  };
  max_revisions: number;
}

export interface HarnessDomain<TaskKind extends string, State> {
  planInitial(ctx: PlanContext<TaskKind, State>): Promise<WorkPlan<TaskKind>>;
  replan(ctx: PlanContext<TaskKind, State>, reason: string): Promise<WorkPlan<TaskKind>>;
  handlers: Record<TaskKind, TaskHandler<State>>;
  evaluate(ctx: PlanContext<TaskKind, State>): Promise<Verdict>;
  isDone(state: State): boolean;
  initState(input: unknown): State;
  serializeState(state: State): object;
  deserializeState(obj: object): State;
}
```

Remove the old generic-method form of `GateResolver` (`<TK, S>` on the call signature). The generic now lives on the type itself.

- [ ] **Step 3: Update `gates.ts`**

```ts
import { createInterface } from "node:readline/promises";
import type { GateDecision, GateEvent, GateResolver } from "./types.js";

export const autoApproveGateResolver: GateResolver = async () => "approve";
export const autoRejectGateResolver: GateResolver = async () => "reject";

export function scriptedGateResolver(script: GateDecision[]): GateResolver {
  const queue = [...script];
  return async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("scripted gate resolver exhausted");
    return next;
  };
}

function summarize(event: GateEvent<string, unknown>): string {
  // body unchanged
}

export function cliGateResolver(): GateResolver {
  return async (event) => {
    // body unchanged
  };
}
```

(Default generics `<string, unknown>` mean existing resolver implementations that don't care about the payload type still compile. Concrete resolvers — e.g. a social-specific resolver — can annotate `GateResolver<SocialTaskKind, SocialState>`.)

- [ ] **Step 4: Update `loop.ts` signature**

```ts
export async function run<TK extends string, S>(
  domain: HarnessDomain<TK, S>,
  input: unknown,
  config: RunConfig<TK, S>,
  infra: InfraBundle,
  domainId: string,
): Promise<RunResult<S>> {
  // body unchanged except for typing through PlanContext calls
}
```

Every `{ state, config }` that's passed into `planInitial` / `replan` / `evaluate` is now a `PlanContext<TK, S>`. TypeScript will drive the fixes — follow the compiler.

- [ ] **Step 5: Update `packages/social-pipeline/src/domain.ts`**

- `makeSocialDomain` returns `HarnessDomain<SocialTaskKind, SocialState>` already — no change.
- `planInitial(ctx: PlanContext<SocialState>)` → `planInitial(ctx: PlanContext<SocialTaskKind, SocialState>)`.
- Same for `replan` and `evaluate`.
- Anywhere social code constructs a `RunConfig`, tighten to `RunConfig<SocialTaskKind, SocialState>`.

- [ ] **Step 6: Fix test call sites**

Most tests will already work because of the default generics. The ones that matter are the ones that explicitly type `RunConfig` or implement a `GateResolver` — those should now use the concrete generics.

- [ ] **Step 7: Build + test**

Run: `pnpm -C packages/harness-core typecheck` — exit 0.
Run: `pnpm -C packages/harness-core test` — all PASS.
Run: `pnpm -C packages/social-pipeline typecheck` — exit 0.
Run: `pnpm -C packages/social-pipeline test` — all PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/harness-core/src/types.ts \
        packages/harness-core/src/gates.ts \
        packages/harness-core/src/loop.ts \
        packages/harness-core/src/index.ts \
        packages/social-pipeline/src/domain.ts \
        packages/harness-core/tests/ \
        packages/social-pipeline/tests/
git commit -m "refactor(core): parameterise GateResolver and RunConfig by <TK, S>"
```

---

## Phase 6 — Crash-Safe Persistence + `resumeRun` API (C1 + C2)

**Design summary for the implementer:**

Today, `snapshot()` does three unsynchronised `writeFile` calls and `appendEvent` uses `appendFile` with no fsync. `loadLatestState` / `loadLatestPlan` independently scan directories with `Math.max`, so if a crash lands between the state write and the plan write you get `state-5.json` paired with `plan-4.json` and no warning.

The fix is in three moves:
1. **Atomic writes** — write every file via `writeAtomic(path, content)` which writes `path.tmp`, `fsync`s, `close`s, then `rename`s to `path`. Rename is atomic on the same filesystem.
2. **Monotonic step counter** — the loop owns a `step` counter (starts at 0, increments once per iteration after applying the delta). `snapshot()` takes the step explicitly. `state-N.json` and `plan-N.json` always use the same `N`.
3. **`resumeRun(runDir)`** — loads the highest `N` where BOTH `state-N.json` and `plan-N.json` exist. If they disagree, truncate to the higher consistent pair. Returns `{ state, plan, budget, step }` for the caller to re-enter `run()` (actual loop resumption wiring is out of scope — this phase ships the API and the consistency guarantee only).

### Task 10: C2 — Atomic write helpers

**Files:**
- Create: `packages/harness-core/src/persistence-atomic.ts`
- Modify: `packages/harness-core/tests/persistence.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/persistence.test.ts`:

```ts
import { writeAtomic } from "../src/persistence-atomic.js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("writeAtomic", () => {
  it("writes the target path and leaves no tmp file on success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-"));
    const target = join(dir, "f.json");
    await writeAtomic(target, '{"hello":"world"}\n');
    expect(await readFile(target, "utf8")).toBe('{"hello":"world"}\n');
    const entries = await readdir(dir);
    expect(entries).toEqual(["f.json"]);
  });

  it("overwrites an existing file atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-"));
    const target = join(dir, "f.json");
    await writeAtomic(target, "first");
    await writeAtomic(target, "second");
    expect(await readFile(target, "utf8")).toBe("second");
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `pnpm -C packages/harness-core test -- persistence.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `persistence-atomic.ts`**

```ts
import { open, rename, unlink } from "node:fs/promises";

export async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  const fd = await open(tmp, "w");
  try {
    await fd.writeFile(content, "utf8");
    await fd.sync();
  } finally {
    await fd.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function appendLineSynced(path: string, line: string): Promise<void> {
  const fd = await open(path, "a");
  try {
    await fd.writeFile(line, "utf8");
    await fd.sync();
  } finally {
    await fd.close();
  }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm -C packages/harness-core test -- persistence.test.ts`
Expected: the two new tests PASS, existing persistence tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/harness-core/src/persistence-atomic.ts \
        packages/harness-core/tests/persistence.test.ts
git commit -m "feat(core): add writeAtomic and appendLineSynced persistence helpers"
```

---

### Task 11: Wire `snapshot` + `appendEvent` through the atomic helpers; add explicit `step`

**Files:**
- Modify: `packages/harness-core/src/persistence.ts`
- Modify: `packages/harness-core/src/loop.ts`
- Modify: `packages/harness-core/tests/persistence.test.ts`

- [ ] **Step 1: Write the failing consistency test**

Add to `tests/persistence.test.ts`:

```ts
import { snapshot, createRun } from "../src/persistence.js";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkPlan, BudgetSnapshot } from "../src/types.js";

const emptyPlan: WorkPlan<string> = {
  plan_id: "p",
  piece_id: "piece-1",
  tasks: [],
  budget_estimate: { tokens: 0, usd: 0, iterations: 0 },
};
const zeroBudget: BudgetSnapshot = {
  used_tokens: 0, used_usd: 0, iterations: 0, wall_seconds: 0, exhausted: false,
};

describe("snapshot — explicit step", () => {
  it("writes state-N and plan-N with the same N", async () => {
    const root = await mkdtemp(join(tmpdir(), "snap-step-"));
    const runDir = await createRun({ run_root: root, run_id: "r1", domain_id: "d", started_at: new Date() });
    await snapshot(runDir, 0, { state: { x: 1 }, plan: emptyPlan, budget: zeroBudget });
    await snapshot(runDir, 1, { state: { x: 2 }, plan: emptyPlan, budget: zeroBudget });
    const stateEntries = (await readdir(join(runDir, "state"))).sort();
    const planEntries = (await readdir(join(runDir, "plan"))).sort();
    expect(stateEntries).toEqual(["state-0.json", "state-1.json"]);
    expect(planEntries).toEqual(["plan-0.json", "plan-1.json"]);
  });
});
```

- [ ] **Step 2: Run — expect fail (signature doesn't accept `step`)**

- [ ] **Step 3: Change `snapshot` signature in `persistence.ts`**

```ts
export async function snapshot(
  runDir: string,
  step: number,
  payload: SnapshotPayload,
): Promise<void> {
  await writeAtomic(
    join(runDir, "state", `state-${step}.json`),
    JSON.stringify(payload.state, null, 2) + "\n",
  );
  await writeAtomic(
    join(runDir, "plan", `plan-${step}.json`),
    JSON.stringify(payload.plan, null, 2) + "\n",
  );
  await writeAtomic(
    join(runDir, "budget.json"),
    JSON.stringify(payload.budget, null, 2) + "\n",
  );
}
```

Delete the `nextIndex` helper entirely — `loadLatestState` and `loadLatestPlan` have their own inline max logic at the current `persistence.ts:76-100` and were the only other potential callers. Grep to be sure: `Grep -n "nextIndex" packages/harness-core/src` should return zero matches after this edit.

`appendEvent` switches to the synced helper:

```ts
export async function appendEvent(runDir: string, entry: EventEntry): Promise<void> {
  await appendLineSynced(join(runDir, "events.jsonl"), JSON.stringify(entry) + "\n");
}
```

- [ ] **Step 4: Thread `step` through `loop.ts`**

Add a `let step = 0;` at the top of `run()`. Replace every `snapshot(runDir, { ... })` call with `snapshot(runDir, step, { ... })`. Increment `step` **once per iteration**, immediately after the last `snapshot()` call in that iteration. The initial `snapshot` call at `loop.ts:80` uses `step = 0`.

Concretely:
- `loop.ts:80` → `await snapshot(runDir, step, { ... });`
- After `loop.ts:128` (gate_after reject snapshot) → `step += 1; continue;`
- After `loop.ts:135` (main iteration snapshot) → `step += 1;`
- `loop.ts:147` (`done` branch snapshot) → reuses the just-incremented step or use `step` then `step += 1`. Either works; pick the one that matches the test.

Implementer: run the tests after each edit; the test from Step 1 pins the invariant.

- [ ] **Step 5: Run full harness-core suite**

Run: `pnpm -C packages/harness-core test`
Expected: all PASS. Loop tests already assert the observable shape of `events.jsonl` and `state-*.json`; they should not need to change since `snapshot` is an internal detail.

- [ ] **Step 6: Commit**

```bash
git add packages/harness-core/src/persistence.ts \
        packages/harness-core/src/loop.ts \
        packages/harness-core/tests/persistence.test.ts
git commit -m "fix(core): thread explicit step counter through snapshot and write atomically"
```

---

### Task 12: C1 — Add `resumeRun(runDir)` with state/plan consistency check

**Files:**
- Modify: `packages/harness-core/src/persistence.ts`
- Modify: `packages/harness-core/src/index.ts`
- Create: `packages/harness-core/tests/resume.test.ts`

- [ ] **Step 1: Write the failing resume test**

```ts
// packages/harness-core/tests/resume.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRun, snapshot, resumeRun } from "../src/persistence.js";
import type { WorkPlan, BudgetSnapshot } from "../src/types.js";

const emptyPlan: WorkPlan<string> = {
  plan_id: "p",
  piece_id: "piece-1",
  tasks: [],
  budget_estimate: { tokens: 0, usd: 0, iterations: 0 },
};

const zeroBudget: BudgetSnapshot = {
  used_tokens: 0,
  used_usd: 0,
  iterations: 0,
  wall_seconds: 0,
  exhausted: false,
};

async function freshRunDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "resume-"));
  return createRun({
    run_root: root,
    run_id: "r1",
    domain_id: "d-test",
    started_at: new Date(),
  });
}

describe("resumeRun", () => {
  it("returns the latest consistent (state, plan) pair", async () => {
    const runDir = await freshRunDir();
    await snapshot(runDir, 0, { state: { v: "a" }, plan: emptyPlan, budget: zeroBudget });
    await snapshot(runDir, 1, { state: { v: "b" }, plan: emptyPlan, budget: zeroBudget });
    const resumed = await resumeRun<{ v: string }, string>(runDir);
    expect(resumed).not.toBeNull();
    expect(resumed!.step).toBe(1);
    expect(resumed!.state.v).toBe("b");
  });

  it("truncates to the last consistent pair when state is ahead of plan", async () => {
    const runDir = await freshRunDir();
    await snapshot(runDir, 0, { state: { v: "a" }, plan: emptyPlan, budget: zeroBudget });
    await snapshot(runDir, 1, { state: { v: "b" }, plan: emptyPlan, budget: zeroBudget });
    // Simulate a crash between state-2 write and plan-2 write:
    await writeFile(join(runDir, "state", "state-2.json"), '{"v":"c"}\n', "utf8");
    const resumed = await resumeRun<{ v: string }, string>(runDir);
    expect(resumed!.step).toBe(1);
    expect(resumed!.state.v).toBe("b");
  });

  it("returns null if nothing has been snapshotted yet", async () => {
    const runDir = await freshRunDir();
    expect(await resumeRun<unknown, string>(runDir)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect fail**

- [ ] **Step 3: Implement `resumeRun` in `persistence.ts`**

```ts
export interface ResumedRun<S, TK extends string> {
  state: S;
  plan: WorkPlan<TK>;
  budget: BudgetSnapshot;
  step: number;
}

function indicesIn(dir: string, prefix: string): Promise<number[]> {
  return readdir(dir)
    .catch(() => [] as string[])
    .then((entries) =>
      entries
        .filter((e) => e.startsWith(`${prefix}-`) && e.endsWith(".json"))
        .map((e) => Number(e.slice(prefix.length + 1, -5)))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b),
    );
}

export async function resumeRun<S, TK extends string>(
  runDir: string,
): Promise<ResumedRun<S, TK> | null> {
  const stateIdxs = new Set(await indicesIn(join(runDir, "state"), "state"));
  const planIdxs = new Set(await indicesIn(join(runDir, "plan"), "plan"));
  let highest = -1;
  for (const n of stateIdxs) {
    if (planIdxs.has(n) && n > highest) highest = n;
  }
  if (highest < 0) return null;
  const [stateRaw, planRaw, budgetRaw] = await Promise.all([
    readFile(join(runDir, "state", `state-${highest}.json`), "utf8"),
    readFile(join(runDir, "plan", `plan-${highest}.json`), "utf8"),
    readFile(join(runDir, "budget.json"), "utf8").catch(() => "null"),
  ]);
  return {
    state: JSON.parse(stateRaw) as S,
    plan: JSON.parse(planRaw) as WorkPlan<TK>,
    budget: (JSON.parse(budgetRaw) as BudgetSnapshot | null) ?? {
      used_tokens: 0, used_usd: 0, iterations: 0, wall_seconds: 0, exhausted: false,
    },
    step: highest,
  };
}
```

- [ ] **Step 4: Export `resumeRun` from `index.ts`**

```ts
export {
  createRun,
  snapshot,
  appendEvent,
  loadLatestState,
  loadLatestPlan,
  resumeRun,
} from "./persistence.js";
```

- [ ] **Step 5: Run tests — expect PASS**

Run: `pnpm -C packages/harness-core test -- resume.test.ts`
Expected: all three PASS.

Run: `pnpm -C packages/harness-core test` (full suite)
Expected: still all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/harness-core/src/persistence.ts \
        packages/harness-core/src/index.ts \
        packages/harness-core/tests/resume.test.ts
git commit -m "feat(core): add resumeRun API with state/plan consistency check"
```

---

## Final Verification

After all twelve tasks land:

- [ ] **Run every suite and typecheck from scratch**

```
pnpm -C packages/harness-core typecheck
pnpm -C packages/harness-core test
pnpm -C packages/social-pipeline typecheck
pnpm -C packages/social-pipeline test
```

Expected:
- harness-core: ≥ 56 tests (43 baseline + 13 new)
- social-pipeline: ≥ 44 tests (41 baseline + 3 new)
- both typechecks exit 0.

- [ ] **Confirm no new `any` or `@ts-expect-error` outside of the pre-existing applyPatch internals**

```
Grep -n ": any" packages/harness-core/src
Grep -n "@ts-expect-error" packages/harness-core/src packages/social-pipeline/src
```

Expected: matches only inside `patch.ts` (unchanged from the pre-refactor baseline).

- [ ] **Confirm the scope boundary**

```
git diff --name-only <pre-plan-sha>..HEAD
```

Expected files (exact list):
```
packages/harness-core/src/patch.ts                 (new)
packages/harness-core/src/persistence-atomic.ts    (new)
packages/harness-core/src/loop.ts
packages/harness-core/src/persistence.ts
packages/harness-core/src/planner.ts
packages/harness-core/src/retry.ts
packages/harness-core/src/types.ts
packages/harness-core/src/gates.ts
packages/harness-core/src/index.ts
packages/harness-core/tests/patch.test.ts          (new)
packages/harness-core/tests/resume.test.ts         (new)
packages/harness-core/tests/loop.test.ts
packages/harness-core/tests/retry.test.ts
packages/harness-core/tests/persistence.test.ts
packages/social-pipeline/src/domain.ts
packages/social-pipeline/tests/init-state.test.ts  (new)
```

No other files should appear in the diff. If anything else does, back it out or stage it as a separate commit and flag it in the PR description.

---

## Known Non-Goals (Intentionally Out of Scope)

- **`packages/harness-core/tsconfig.json` `exclude: ["tests"]`** — deliberate; catching test-level type regressions belongs to its own sprint, and fixing it here would drag in every test file type update at once.
- **`done` branch redundant `snapshot()` call at `loop.ts:147`** — will naturally get cleaned up during Phase 6 when the `step` counter is threaded through, but not called out as its own task. If it survives Phase 6, file it as a minor follow-up.
- **Persisting the `pre_publish` gate decision into `events.jsonl`** — separately known backlog item; intentionally deferred so Phase 6 stays focused on crash-safety, not audit-completeness.
- **`stuckChecks > 3` magic number, `Budget.snapshot()` wall-time non-determinism, plan-id `Date.now()`** — minor findings from the audit, not in scope.
- **Handler `previousError` feedback argument** — mentioned as a nice-to-have for I4; not in scope because it changes the `TaskHandler` signature across all handlers and deserves its own design discussion.
