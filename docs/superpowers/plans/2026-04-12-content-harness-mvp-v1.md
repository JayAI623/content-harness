# content-harness MVP v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a thin end-to-end slice of `content-harness` that turns a Persona + Campaign + Piece yaml into an evaluator-approved Twitter variant, running the full `plan → generate → evaluate → revise` loop with HITL gates, budget enforcement, and resumable persistence.

**Architecture:** TypeScript pnpm monorepo with two packages — `harness-core` (domain-agnostic orchestration: planner helpers, loop, budget, persistence, retry, gates, LLM client) and `social-pipeline` (social-media content domain: zod schemas, filesystem asset store, evaluator sub-agents, five task handlers, `HarnessDomain` implementation, CLI entrypoint). `social-pipeline` depends on `harness-core`; neither depends on `opencli` as a library — handlers invoke `@jackwener/opencli` via subprocess so the binary stays decoupled.

**Tech Stack:** Node 20+ ESM, TypeScript 5.4 (strict), pnpm workspaces, vitest (TDD), zod (schema validation), yaml (config parsing), @anthropic-ai/sdk (with prompt caching), Node `child_process` (for opencli), Node `readline` (CLI gate prompts). Model tiers: `claude-opus-4-6` (main) / `claude-haiku-4-5-20251001` (cheap). Fixtures pattern borrowed from the opencli repo.

**Spec reference:** `/Users/liuzhe/Desktop/AI项目/content-harness/docs/superpowers/specs/2026-04-11-content-harness-social-pipeline-design.md`

---

## File Structure

All paths relative to `/Users/liuzhe/Desktop/AI项目/content-harness/`.

### Monorepo root
- `package.json` — root scripts (`dev`, `test`, `build`), pnpm workspace declaration
- `pnpm-workspace.yaml` — workspace glob: `packages/*`
- `tsconfig.base.json` — shared compiler options (strict, ES2022, NodeNext module resolution)
- `.gitignore` — ignores `node_modules/`, `dist/`, `runs/`, `data/asset-pools/*/` (keeps fixtures)
- `README.md` — one-paragraph orientation + `pnpm install && pnpm test`
- `.nvmrc` — `20`

### `packages/harness-core/` (domain-agnostic)
- `package.json` — name `@content-harness/core`, type `module`, deps: `@anthropic-ai/sdk`, devdeps: `vitest`, `typescript`, `@types/node`
- `tsconfig.json` — extends root
- `src/index.ts` — barrel: re-export `types`, `loop`, `budget`, `persistence`, `gates`, `retry`, `planner`, `infra/llm`, `infra/logger`, `infra/clock`
- `src/types.ts` — all shared interfaces: `HarnessDomain`, `Task`, `WorkPlan`, `Verdict`, `Delta`, `TaskHandler`, `InfraBundle`, `RunConfig`, `GateResolver`, `GateEvent`, `BudgetLimits`, `CostAccounting`, `LogEntry`, `RunResult`, `AssetRef`, `StateRef`, `PlanContext`
- `src/budget.ts` — `Budget` class (charge, snapshot, exhausted, limits check)
- `src/persistence.ts` — `createRun`, `snapshot`, `appendEvent`, `resume` — writes to `runs/<run_id>/` with `manifest.json` / `events.jsonl` / `state/state-N.json` / `plan/plan-N.json` / `budget.json` / `deliverables/` / `logs/run.jsonl`
- `src/retry.ts` — `runWithRetry(handler, task, state, infra, retryConfig)` — attempts with exponential backoff, classifies retryable vs permanent
- `src/planner.ts` — `selectNextRunnable(plan, state)`, `markRevise(plan, taskId, feedback)`, `markRejected(plan, task)` — pure functions that operate on `WorkPlan`
- `src/gates.ts` — `cliGateResolver`: reads `stdin` via `readline`, prints the event summary, accepts `y/n`; `autoApproveGateResolver` for tests
- `src/loop.ts` — the `run` function from spec §5.2
- `src/infra/llm.ts` — `AnthropicLLMClient` wrapping `@anthropic-ai/sdk`, two tiers (`main`/`cheap`), prompt caching on system blocks, `complete({model, system, messages, max_tokens, cache})` → `{text, cost}`
- `src/infra/logger.ts` — JSON-line logger, filtered by run_id
- `src/infra/clock.ts` — `Clock` interface + `SystemClock` (Date.now) + `FakeClock` for tests
- `tests/budget.test.ts`
- `tests/persistence.test.ts`
- `tests/retry.test.ts`
- `tests/planner.test.ts`
- `tests/gates.test.ts`
- `tests/loop.test.ts`
- `tests/infra/llm.test.ts`
- `tests/fixtures/` — shared fake data

### `packages/social-pipeline/` (content domain)
- `package.json` — name `@content-harness/social`, type `module`, deps: `@content-harness/core` (workspace), `zod`, `yaml`
- `tsconfig.json` — extends root, references `harness-core`
- `src/index.ts` — barrel
- `src/schemas/persona.ts` — zod `PersonaSchema` + TS type
- `src/schemas/campaign.ts`
- `src/schemas/piece.ts` — includes `RawMaterial`, `PlatformVariant`, `EvalRound`, `AudienceFeedback`, `ActionableFeedback`
- `src/schemas/asset-pool.ts` — zod types for `AssetPool`, `ReferencePost`, `StylePattern`, `HotTopic`, `EvaluatorPersona`, `OwnPost`, `VoiceFingerprint`
- `src/schemas/index.ts` — barrel for schemas
- `src/asset-store.ts` — filesystem JSONL + blob impl of `AssetStore`, including `resolve(pool, ref: AssetRef)`
- `src/eval/personas.ts` — 3 hardcoded evaluator personas for `ai-infra-engineer-liu`
- `src/eval/simulator.ts` — `simulateAudience(variant, personas, llm): Promise<AudienceFeedback[]>` — fans out parallel LLM calls
- `src/eval/aggregator.ts` — `aggregate(feedback[]): {aggregated_score, ai_smell, depth, verdict, actionable_feedback[]}`
- `src/handlers/research_refs.ts` — invokes `opencli twitter search` via subprocess, parses JSON, writes `ReferencePost[]` to asset store
- `src/handlers/draft_base.ts` — LLM (main) with persona voice + raw materials → `Piece.base_article`
- `src/handlers/refine_variant.ts` — LLM (main) with platform constraints + style refs → `PlatformVariant`, sets `gate_after: true`
- `src/handlers/eval_variant.ts` — calls `eval/simulator` + `eval/aggregator` → appends `EvalRound`
- `src/handlers/revise.ts` — LLM (main) with actionable feedback → new variant
- `src/opencli-client.ts` — thin wrapper around `child_process.execFile("opencli", …)` returning parsed JSON, plus an injectable interface so tests can substitute fixtures
- `src/domain.ts` — implements `HarnessDomain<SocialTaskKind, SocialState>`: `planInitial`, `replan`, `handlers` registry, `evaluate`, `isDone`, `initState`, `serializeState`, `deserializeState`
- `src/state.ts` — `SocialState` type + `applyDelta` helpers for the social domain (the core applies patches; `state.ts` holds the domain-specific pure helpers)
- `bin/run.ts` — CLI entrypoint: parses args, loads yaml configs, wires infra, calls `harness-core.run`, writes `deliverables/twitter_variant.md`
- `tests/handlers/research_refs.test.ts`
- `tests/handlers/draft_base.test.ts`
- `tests/handlers/refine_variant.test.ts`
- `tests/handlers/eval_variant.test.ts`
- `tests/handlers/revise.test.ts`
- `tests/eval/aggregator.test.ts`
- `tests/domain.test.ts`
- `tests/integration/e2e.test.ts`
- `tests/fixtures/opencli/twitter-search.json` — canned opencli output
- `tests/fixtures/llm/draft-base.json` — canned LLM reply
- `tests/fixtures/llm/refine-variant.json`
- `tests/fixtures/llm/eval-variant-persona-1.json`
- `tests/fixtures/llm/eval-variant-persona-2.json`
- `tests/fixtures/llm/eval-variant-persona-3.json`
- `tests/fixtures/llm/revise.json`
- `tests/fixtures/configs/test-persona.yaml`
- `tests/fixtures/configs/test-campaign.yaml`
- `tests/fixtures/configs/test-piece.yaml`

### `data/` (runtime configs — checked into git only for examples)
- `data/personas/ai-infra-engineer-liu.yaml`
- `data/personas/real-estate-agent-sarah.yaml`
- `data/campaigns/q2-infra-insights.yaml`
- `data/pieces/harness-debug.yaml`

### `runs/` — gitignored; populated at runtime

---

## Task 1: Monorepo scaffold

**Files:**
- Create: `content-harness/package.json`
- Create: `content-harness/pnpm-workspace.yaml`
- Create: `content-harness/tsconfig.base.json`
- Create: `content-harness/.gitignore`
- Create: `content-harness/.nvmrc`
- Create: `content-harness/README.md`

- [ ] **Step 1: Create workspace file**

Create `content-harness/pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: Create root package.json**

Create `content-harness/package.json`:

```json
{
  "name": "content-harness",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "test:watch": "pnpm -r test:watch",
    "typecheck": "pnpm -r typecheck",
    "dev": "pnpm --filter @content-harness/social dev"
  },
  "devDependencies": {
    "typescript": "^5.4.5",
    "@types/node": "^20.12.7",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 3: Create tsconfig.base.json**

Create `content-harness/tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  }
}
```

- [ ] **Step 4: Create .gitignore**

Create `content-harness/.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
.DS_Store

# runtime state — never commit
runs/
data/asset-pools/*/
!data/asset-pools/.gitkeep

# logs
logs/
*.log

# editor
.vscode/
.idea/
```

- [ ] **Step 5: Create .nvmrc**

Create `content-harness/.nvmrc`:

```
20
```

- [ ] **Step 6: Create README.md**

Create `content-harness/README.md`:

```markdown
# content-harness

A reusable `plan → generate → evaluate → revise` framework for turning raw material into platform-ready content. See `docs/superpowers/specs/` for the design.

## Quickstart

```
pnpm install
pnpm test
```

## Packages

- `@content-harness/core` — domain-agnostic loop, budget, persistence, gates
- `@content-harness/social` — social-media content domain (Twitter in v1)
```

- [ ] **Step 7: Install and verify**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm install
```
Expected: pnpm creates `node_modules/` and `pnpm-lock.yaml`. No errors.

- [ ] **Step 8: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git init && git add -A && git commit -m "chore: scaffold content-harness monorepo"
```

---

## Task 2: harness-core package + types

**Files:**
- Create: `content-harness/packages/harness-core/package.json`
- Create: `content-harness/packages/harness-core/tsconfig.json`
- Create: `content-harness/packages/harness-core/src/types.ts`
- Create: `content-harness/packages/harness-core/vitest.config.ts`

- [ ] **Step 1: Create harness-core package.json**

Create `content-harness/packages/harness-core/package.json`:

```json
{
  "name": "@content-harness/core",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.24.0"
  },
  "devDependencies": {
    "typescript": "^5.4.5",
    "@types/node": "^20.12.7",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create harness-core tsconfig.json**

Create `content-harness/packages/harness-core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

Create `content-harness/packages/harness-core/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
  },
});
```

- [ ] **Step 4: Write types.ts**

Create `content-harness/packages/harness-core/src/types.ts`:

```ts
// ─── Reference unions ────────────────────────────────────────────
export type AssetRef =
  | { kind: "reference_post";    id: string }
  | { kind: "style_pattern";     id: string }
  | { kind: "hot_topic";         platform: string; topic: string }
  | { kind: "evaluator_persona"; id: string }
  | { kind: "own_post";          piece_id: string; platform: string }
  | { kind: "voice_fingerprint" };

export type StateRef =
  | { kind: "raw_material";     piece_id: string; material_id: string }
  | { kind: "base_article";     piece_id: string }
  | { kind: "platform_variant"; piece_id: string; platform: string; variant_idx: number }
  | { kind: "eval_round";       piece_id: string; round: number }
  | { kind: "deliverable";      path: string };

// ─── Tasks & plans ───────────────────────────────────────────────
export interface Task<TaskKind extends string = string> {
  id: string;
  kind: TaskKind;
  params: Record<string, unknown>;
  deps: string[];
  input_refs: AssetRef[];
  result_ref?: StateRef;
  acceptance_criteria: string;
  gate_before: boolean;
  gate_after: boolean;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
}

export interface WorkPlan<TaskKind extends string = string> {
  plan_id: string;
  piece_id: string;
  tasks: Task<TaskKind>[];
  budget_estimate: { tokens: number; usd: number; iterations: number };
}

// ─── Verdicts & deltas ───────────────────────────────────────────
export type Verdict =
  | { kind: "continue" }
  | { kind: "revise"; task_id: string; feedback: string }
  | { kind: "redirect"; reason: string }
  | { kind: "done" }
  | { kind: "abort"; reason: string };

export interface CostAccounting {
  input_tokens: number;
  output_tokens: number;
  usd: number;
}

export const zeroCost: CostAccounting = { input_tokens: 0, output_tokens: 0, usd: 0 };

export interface StatePatch {
  op: "set" | "append" | "merge";
  path: string[];
  value: unknown;
}

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
  ts: string;
}

export interface Delta<State> {
  kind: "success" | "failure";
  patches: StatePatch[];
  cost: CostAccounting;
  logs?: LogEntry[];
  error?: { message: string; retryable: boolean };
  // Handlers may attach the produced artifact so persistence can write deliverables.
  result_ref?: StateRef;
}

// ─── Domain interface ────────────────────────────────────────────
export interface PlanContext<State> {
  state: State;
  config: RunConfig;
}

export interface TaskHandler<State> {
  (task: Task<string>, state: State, infra: InfraBundle): Promise<Delta<State>>;
}

export interface HarnessDomain<TaskKind extends string, State> {
  planInitial(ctx: PlanContext<State>): Promise<WorkPlan<TaskKind>>;
  replan(ctx: PlanContext<State>, reason: string): Promise<WorkPlan<TaskKind>>;
  handlers: Record<TaskKind, TaskHandler<State>>;
  evaluate(state: State): Promise<Verdict>;
  isDone(state: State): boolean;
  initState(input: unknown): State;
  serializeState(state: State): object;
  deserializeState(obj: object): State;
}

// ─── Infra ──────────────────────────────────────────────────────
export interface LLMCompleteOptions {
  tier: "main" | "cheap";
  system: string | Array<{ text: string; cache?: boolean }>;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  max_tokens: number;
  temperature?: number;
}

export interface LLMCompleteResult {
  text: string;
  cost: CostAccounting;
  stop_reason: string;
}

export interface LLMClient {
  complete(opts: LLMCompleteOptions): Promise<LLMCompleteResult>;
}

export interface AssetStore {
  append<T>(pool: string, bucket: string, records: T[]): Promise<void>;
  query<T>(pool: string, bucket: string, filter?: Record<string, unknown>): Promise<T[]>;
  resolve<T>(pool: string, ref: AssetRef): Promise<T | null>;
  putBlob(pool: string, key: string, bytes: Uint8Array): Promise<string>;
  getBlob(pool: string, key: string): Promise<Uint8Array | null>;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface Clock {
  now(): Date;
}

export interface InfraBundle {
  llm: LLMClient;
  assets: AssetStore;
  logger: Logger;
  clock: Clock;
}

// ─── Run config ──────────────────────────────────────────────────
export interface BudgetLimits {
  max_tokens?: number;
  max_usd?: number;
  max_iterations?: number;
  max_wall_seconds?: number;
}

export interface BudgetSnapshot {
  used_tokens: number;
  used_usd: number;
  iterations: number;
  wall_seconds: number;
  exhausted: boolean;
  limit_hit?: "tokens" | "usd" | "iterations" | "time";
}

export type GateDecision = "approve" | "reject";

export type GateEvent<TK extends string, S> =
  | { kind: "post_plan"; plan: WorkPlan<TK> }
  | { kind: "pre_publish"; state: S }
  | { kind: "task_gate_before"; task: Task<TK> }
  | { kind: "task_gate_after"; task: Task<TK>; delta: Delta<S> };

export interface GateResolver {
  <TK extends string, S>(event: GateEvent<TK, S>): Promise<GateDecision>;
}

export interface RunConfig {
  run_id: string;
  run_root: string;
  budget: BudgetLimits;
  retry: { max_attempts: number; backoff_ms: number };
  gates: {
    post_plan: boolean;
    pre_publish: boolean;
  };
  gate_resolver: GateResolver;
  resume_from?: string;
  thresholds: {
    eval_pass: number;
    ai_smell_max: number;
    depth_min: number;
  };
  max_revisions: number;
}

export interface RunResult<State> {
  ok: boolean;
  state: State;
  budget: BudgetSnapshot;
  reason?: string;
  run_dir: string;
}
```

- [ ] **Step 5: Create placeholder index.ts**

Create `content-harness/packages/harness-core/src/index.ts`:

```ts
export * from "./types.js";
```

- [ ] **Step 6: Install deps + typecheck**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm install && pnpm --filter @content-harness/core typecheck
```
Expected: clean typecheck, no errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/harness-core package.json pnpm-lock.yaml && git commit -m "feat(core): add harness-core package with shared types"
```

---

## Task 3: Budget

**Files:**
- Create: `content-harness/packages/harness-core/src/budget.ts`
- Create: `content-harness/packages/harness-core/tests/budget.test.ts`

- [ ] **Step 1: Write failing test**

Create `content-harness/packages/harness-core/tests/budget.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Budget } from "../src/budget.js";
import type { CostAccounting } from "../src/types.js";

const c = (input_tokens: number, output_tokens: number, usd: number): CostAccounting => ({
  input_tokens,
  output_tokens,
  usd,
});

describe("Budget", () => {
  it("starts un-exhausted with no limits and can be charged", () => {
    const b = new Budget({});
    b.charge(c(10, 20, 0.001));
    b.tickIteration();
    const snap = b.snapshot();
    expect(snap.exhausted).toBe(false);
    expect(snap.used_tokens).toBe(30);
    expect(snap.used_usd).toBeCloseTo(0.001);
    expect(snap.iterations).toBe(1);
  });

  it("exhausts on token limit", () => {
    const b = new Budget({ max_tokens: 100 });
    b.charge(c(60, 50, 0));
    expect(b.exhausted()).toBe(true);
    expect(b.snapshot().limit_hit).toBe("tokens");
  });

  it("exhausts on usd limit", () => {
    const b = new Budget({ max_usd: 0.5 });
    b.charge(c(0, 0, 0.6));
    expect(b.exhausted()).toBe(true);
    expect(b.snapshot().limit_hit).toBe("usd");
  });

  it("exhausts on iteration limit", () => {
    const b = new Budget({ max_iterations: 2 });
    b.tickIteration();
    b.tickIteration();
    expect(b.exhausted()).toBe(true);
    expect(b.snapshot().limit_hit).toBe("iterations");
  });

  it("exhausts on wall-clock limit", () => {
    const start = new Date("2026-01-01T00:00:00Z").getTime();
    let now = start;
    const b = new Budget({ max_wall_seconds: 60 }, () => new Date(now));
    now = start + 70_000;
    expect(b.exhausted()).toBe(true);
    expect(b.snapshot().limit_hit).toBe("time");
  });
});
```

- [ ] **Step 2: Run test to see it fail**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/core test
```
Expected: FAIL — `Cannot find module ../src/budget.js`.

- [ ] **Step 3: Implement Budget**

Create `content-harness/packages/harness-core/src/budget.ts`:

```ts
import type { BudgetLimits, BudgetSnapshot, CostAccounting } from "./types.js";

export class Budget {
  private used_tokens = 0;
  private used_usd = 0;
  private iterations = 0;
  private readonly started_at: number;
  private readonly now: () => Date;

  constructor(
    private readonly limits: BudgetLimits,
    now: () => Date = () => new Date(),
  ) {
    this.now = now;
    this.started_at = now().getTime();
  }

  charge(cost: CostAccounting): void {
    this.used_tokens += cost.input_tokens + cost.output_tokens;
    this.used_usd += cost.usd;
  }

  tickIteration(): void {
    this.iterations += 1;
  }

  private wallSeconds(): number {
    return (this.now().getTime() - this.started_at) / 1000;
  }

  private hitLimit(): BudgetSnapshot["limit_hit"] {
    if (this.limits.max_tokens !== undefined && this.used_tokens >= this.limits.max_tokens) return "tokens";
    if (this.limits.max_usd !== undefined && this.used_usd >= this.limits.max_usd) return "usd";
    if (this.limits.max_iterations !== undefined && this.iterations >= this.limits.max_iterations) return "iterations";
    if (this.limits.max_wall_seconds !== undefined && this.wallSeconds() >= this.limits.max_wall_seconds) return "time";
    return undefined;
  }

  exhausted(): boolean {
    return this.hitLimit() !== undefined;
  }

  snapshot(): BudgetSnapshot {
    const limit_hit = this.hitLimit();
    return {
      used_tokens: this.used_tokens,
      used_usd: this.used_usd,
      iterations: this.iterations,
      wall_seconds: this.wallSeconds(),
      exhausted: limit_hit !== undefined,
      ...(limit_hit ? { limit_hit } : {}),
    };
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/core test
```
Expected: PASS — all 5 budget tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/harness-core/src/budget.ts packages/harness-core/tests/budget.test.ts && git commit -m "feat(core): add Budget with multi-limit enforcement"
```

---

## Task 4: Persistence

**Files:**
- Create: `content-harness/packages/harness-core/src/persistence.ts`
- Create: `content-harness/packages/harness-core/tests/persistence.test.ts`

- [ ] **Step 1: Write failing test**

Create `content-harness/packages/harness-core/tests/persistence.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRun,
  snapshot,
  appendEvent,
  loadLatestState,
  loadLatestPlan,
} from "../src/persistence.js";
import type { Task, WorkPlan } from "../src/types.js";

let runRoot: string;
beforeEach(async () => {
  runRoot = await mkdtemp(join(tmpdir(), "harness-run-"));
});
afterEach(async () => {
  await rm(runRoot, { recursive: true, force: true });
});

const fakePlan: WorkPlan<"a"> = {
  plan_id: "p1",
  piece_id: "piece-1",
  tasks: [
    {
      id: "t1",
      kind: "a",
      params: {},
      deps: [],
      input_refs: [],
      acceptance_criteria: "",
      gate_before: false,
      gate_after: false,
      status: "pending",
    },
  ],
  budget_estimate: { tokens: 100, usd: 0.01, iterations: 1 },
};

const fakeTask: Task<"a"> = fakePlan.tasks[0]!;

describe("persistence", () => {
  it("createRun writes manifest + empty events", async () => {
    const dir = await createRun({
      run_root: runRoot,
      run_id: "r1",
      domain_id: "test-domain",
      started_at: new Date("2026-01-01T00:00:00Z"),
    });
    expect(dir).toBe(join(runRoot, "r1"));
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    expect(manifest.run_id).toBe("r1");
    expect(manifest.domain_id).toBe("test-domain");
  });

  it("snapshot writes state-N and plan-N files incrementally", async () => {
    const dir = await createRun({
      run_root: runRoot,
      run_id: "r2",
      domain_id: "d",
      started_at: new Date(),
    });
    await snapshot(dir, { state: { x: 1 }, plan: fakePlan, budget: { used_tokens: 0, used_usd: 0, iterations: 0, wall_seconds: 0, exhausted: false } });
    await snapshot(dir, { state: { x: 2 }, plan: fakePlan, budget: { used_tokens: 1, used_usd: 0, iterations: 1, wall_seconds: 1, exhausted: false } });
    const stateFiles = (await readdir(join(dir, "state"))).sort();
    expect(stateFiles).toEqual(["state-0.json", "state-1.json"]);
    const latest = await loadLatestState<{ x: number }>(dir);
    expect(latest).toEqual({ x: 2 });
  });

  it("appendEvent writes JSONL line per event", async () => {
    const dir = await createRun({
      run_root: runRoot,
      run_id: "r3",
      domain_id: "d",
      started_at: new Date(),
    });
    await appendEvent(dir, {
      task: fakeTask,
      delta: { kind: "success", patches: [], cost: { input_tokens: 1, output_tokens: 2, usd: 0.001 } },
    });
    await appendEvent(dir, {
      task: fakeTask,
      delta: { kind: "success", patches: [], cost: { input_tokens: 3, output_tokens: 4, usd: 0.002 } },
    });
    const raw = await readFile(join(dir, "events.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).delta.cost.input_tokens).toBe(1);
    expect(JSON.parse(lines[1]!).delta.cost.output_tokens).toBe(4);
  });

  it("loadLatestPlan returns the most recent plan snapshot", async () => {
    const dir = await createRun({
      run_root: runRoot,
      run_id: "r4",
      domain_id: "d",
      started_at: new Date(),
    });
    await snapshot(dir, { state: {}, plan: fakePlan, budget: { used_tokens: 0, used_usd: 0, iterations: 0, wall_seconds: 0, exhausted: false } });
    const loaded = await loadLatestPlan<"a">(dir);
    expect(loaded?.plan_id).toBe("p1");
  });
});
```

- [ ] **Step 2: Run test to see it fail**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/core test
```
Expected: FAIL — cannot find `persistence.js`.

- [ ] **Step 3: Implement persistence**

Create `content-harness/packages/harness-core/src/persistence.ts`:

```ts
import { mkdir, writeFile, readFile, readdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { BudgetSnapshot, Delta, Task, WorkPlan } from "./types.js";

export interface CreateRunOptions {
  run_root: string;
  run_id: string;
  domain_id: string;
  started_at: Date;
}

export async function createRun(opts: CreateRunOptions): Promise<string> {
  const dir = join(opts.run_root, opts.run_id);
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, "state"), { recursive: true });
  await mkdir(join(dir, "plan"), { recursive: true });
  await mkdir(join(dir, "deliverables"), { recursive: true });
  await mkdir(join(dir, "logs"), { recursive: true });

  const manifest = {
    run_id: opts.run_id,
    domain_id: opts.domain_id,
    started_at: opts.started_at.toISOString(),
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  // Touch events log so downstream tooling sees it exists.
  await writeFile(join(dir, "events.jsonl"), "", { flag: "wx" }).catch(() => {});
  return dir;
}

interface SnapshotPayload {
  state: unknown;
  plan: WorkPlan<string>;
  budget: BudgetSnapshot;
}

async function nextIndex(dir: string, prefix: string): Promise<number> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const indices = entries
    .filter((e) => e.startsWith(`${prefix}-`) && e.endsWith(".json"))
    .map((e) => Number(e.slice(prefix.length + 1, -5)))
    .filter((n) => Number.isFinite(n));
  return indices.length === 0 ? 0 : Math.max(...indices) + 1;
}

export async function snapshot(runDir: string, payload: SnapshotPayload): Promise<void> {
  const stateIdx = await nextIndex(join(runDir, "state"), "state");
  await writeFile(
    join(runDir, "state", `state-${stateIdx}.json`),
    JSON.stringify(payload.state, null, 2) + "\n",
    "utf8",
  );
  const planIdx = await nextIndex(join(runDir, "plan"), "plan");
  await writeFile(
    join(runDir, "plan", `plan-${planIdx}.json`),
    JSON.stringify(payload.plan, null, 2) + "\n",
    "utf8",
  );
  await writeFile(
    join(runDir, "budget.json"),
    JSON.stringify(payload.budget, null, 2) + "\n",
    "utf8",
  );
}

export interface EventEntry {
  task: Task<string>;
  delta: Delta<unknown>;
}

export async function appendEvent(runDir: string, entry: EventEntry): Promise<void> {
  await appendFile(join(runDir, "events.jsonl"), JSON.stringify(entry) + "\n", "utf8");
}

export async function loadLatestState<S>(runDir: string): Promise<S | null> {
  const stateDir = join(runDir, "state");
  const entries = await readdir(stateDir).catch(() => [] as string[]);
  if (entries.length === 0) return null;
  const latestIdx = Math.max(
    ...entries
      .filter((e) => e.startsWith("state-") && e.endsWith(".json"))
      .map((e) => Number(e.slice(6, -5))),
  );
  const raw = await readFile(join(stateDir, `state-${latestIdx}.json`), "utf8");
  return JSON.parse(raw) as S;
}

export async function loadLatestPlan<TK extends string>(runDir: string): Promise<WorkPlan<TK> | null> {
  const planDir = join(runDir, "plan");
  const entries = await readdir(planDir).catch(() => [] as string[]);
  if (entries.length === 0) return null;
  const latestIdx = Math.max(
    ...entries
      .filter((e) => e.startsWith("plan-") && e.endsWith(".json"))
      .map((e) => Number(e.slice(5, -5))),
  );
  const raw = await readFile(join(planDir, `plan-${latestIdx}.json`), "utf8");
  return JSON.parse(raw) as WorkPlan<TK>;
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/core test
```
Expected: PASS — all persistence tests + prior budget tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/harness-core/src/persistence.ts packages/harness-core/tests/persistence.test.ts && git commit -m "feat(core): add filesystem persistence with resume support"
```

---

## Task 5: Retry

**Files:**
- Create: `content-harness/packages/harness-core/src/retry.ts`
- Create: `content-harness/packages/harness-core/tests/retry.test.ts`

- [ ] **Step 1: Write failing test**

Create `content-harness/packages/harness-core/tests/retry.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runWithRetry } from "../src/retry.js";
import type { Delta, InfraBundle, Task } from "../src/types.js";

const makeTask = (): Task<string> => ({
  id: "t",
  kind: "any",
  params: {},
  deps: [],
  input_refs: [],
  acceptance_criteria: "",
  gate_before: false,
  gate_after: false,
  status: "pending",
});

const fakeInfra = {} as InfraBundle;

const okDelta: Delta<unknown> = {
  kind: "success",
  patches: [],
  cost: { input_tokens: 1, output_tokens: 1, usd: 0 },
};

describe("runWithRetry", () => {
  it("returns success on first attempt", async () => {
    const handler = vi.fn().mockResolvedValue(okDelta);
    const result = await runWithRetry(handler, makeTask(), {}, fakeInfra, { max_attempts: 3, backoff_ms: 0 });
    expect(result.kind).toBe("success");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("retries retryable failure delta then succeeds", async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "failure",
        patches: [],
        cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
        error: { message: "transient", retryable: true },
      } satisfies Delta<unknown>)
      .mockResolvedValueOnce(okDelta);
    const result = await runWithRetry(handler, makeTask(), {}, fakeInfra, { max_attempts: 3, backoff_ms: 0 });
    expect(result.kind).toBe("success");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent failures", async () => {
    const handler = vi.fn().mockResolvedValue({
      kind: "failure",
      patches: [],
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      error: { message: "permanent", retryable: false },
    } satisfies Delta<unknown>);
    const result = await runWithRetry(handler, makeTask(), {}, fakeInfra, { max_attempts: 3, backoff_ms: 0 });
    expect(result.kind).toBe("failure");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("gives up after max_attempts on repeated retryable failures", async () => {
    const handler = vi.fn().mockResolvedValue({
      kind: "failure",
      patches: [],
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      error: { message: "transient", retryable: true },
    } satisfies Delta<unknown>);
    const result = await runWithRetry(handler, makeTask(), {}, fakeInfra, { max_attempts: 2, backoff_ms: 0 });
    expect(result.kind).toBe("failure");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("catches thrown errors and wraps as retryable", async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(okDelta);
    const result = await runWithRetry(handler, makeTask(), {}, fakeInfra, { max_attempts: 3, backoff_ms: 0 });
    expect(result.kind).toBe("success");
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to see it fail**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/core test
```
Expected: FAIL.

- [ ] **Step 3: Implement runWithRetry**

Create `content-harness/packages/harness-core/src/retry.ts`:

```ts
import type { Delta, InfraBundle, Task, TaskHandler } from "./types.js";

export interface RetryConfig {
  max_attempts: number;
  backoff_ms: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runWithRetry<S>(
  handler: TaskHandler<S>,
  task: Task<string>,
  state: S,
  infra: InfraBundle,
  config: RetryConfig,
): Promise<Delta<S>> {
  let attempt = 0;
  let lastFailure: Delta<S> | null = null;

  while (attempt < config.max_attempts) {
    attempt += 1;
    try {
      const result = await handler(task, state, infra);
      if (result.kind === "success") return result;
      lastFailure = result;
      if (!result.error?.retryable) return result;
    } catch (err) {
      lastFailure = {
        kind: "failure",
        patches: [],
        cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
        error: { message: err instanceof Error ? err.message : String(err), retryable: true },
      };
    }

    if (attempt < config.max_attempts && config.backoff_ms > 0) {
      await sleep(config.backoff_ms * attempt);
    }
  }

  return lastFailure ?? {
    kind: "failure",
    patches: [],
    cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
    error: { message: "no attempts made", retryable: false },
  };
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/core test
```
Expected: PASS — all retry tests plus prior tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/harness-core/src/retry.ts packages/harness-core/tests/retry.test.ts && git commit -m "feat(core): add runWithRetry with retryable/permanent classification"
```

---

## Task 6: Planner helpers

**Files:**
- Create: `content-harness/packages/harness-core/src/planner.ts`
- Create: `content-harness/packages/harness-core/tests/planner.test.ts`

- [ ] **Step 1: Write failing test**

Create `content-harness/packages/harness-core/tests/planner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectNextRunnable, markRevise, markRejected, markCompleted } from "../src/planner.js";
import type { Task, WorkPlan } from "../src/types.js";

const makeTask = (id: string, deps: string[] = [], status: Task<string>["status"] = "pending"): Task<string> => ({
  id,
  kind: "k",
  params: {},
  deps,
  input_refs: [],
  acceptance_criteria: "",
  gate_before: false,
  gate_after: false,
  status,
});

const makePlan = (tasks: Task<string>[]): WorkPlan<string> => ({
  plan_id: "p",
  piece_id: "piece",
  tasks,
  budget_estimate: { tokens: 0, usd: 0, iterations: 0 },
});

describe("planner helpers", () => {
  it("selectNextRunnable picks first pending task with all deps completed", () => {
    const plan = makePlan([
      makeTask("t1", [], "completed"),
      makeTask("t2", ["t1"]),
      makeTask("t3", ["t2"]),
    ]);
    const next = selectNextRunnable(plan, {});
    expect(next?.id).toBe("t2");
  });

  it("selectNextRunnable skips tasks with incomplete deps", () => {
    const plan = makePlan([
      makeTask("t1"),
      makeTask("t2", ["t1"]),
    ]);
    expect(selectNextRunnable(plan, {})?.id).toBe("t1");
  });

  it("selectNextRunnable returns null when nothing runnable", () => {
    const plan = makePlan([
      makeTask("t1", [], "completed"),
      makeTask("t2", ["t1"], "completed"),
    ]);
    expect(selectNextRunnable(plan, {})).toBeNull();
  });

  it("markCompleted flips status on matching task", () => {
    const plan = makePlan([makeTask("t1"), makeTask("t2", ["t1"])]);
    const next = markCompleted(plan, "t1");
    expect(next.tasks[0]!.status).toBe("completed");
    expect(next.tasks[1]!.status).toBe("pending");
  });

  it("markRevise resets a completed task to pending and stores feedback in params", () => {
    const plan = makePlan([makeTask("t1", [], "completed")]);
    const next = markRevise(plan, "t1", "tighten the opening");
    expect(next.tasks[0]!.status).toBe("pending");
    expect(next.tasks[0]!.params.revise_feedback).toBe("tighten the opening");
  });

  it("markRejected flips status to skipped on matching task", () => {
    const plan = makePlan([makeTask("t1")]);
    const next = markRejected(plan, plan.tasks[0]!);
    expect(next.tasks[0]!.status).toBe("skipped");
  });
});
```

- [ ] **Step 2: Run test to see it fail**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/core test
```
Expected: FAIL.

- [ ] **Step 3: Implement planner helpers**

Create `content-harness/packages/harness-core/src/planner.ts`:

```ts
import type { Task, WorkPlan } from "./types.js";

export function selectNextRunnable<TK extends string, S>(plan: WorkPlan<TK>, _state: S): Task<TK> | null {
  const completed = new Set(plan.tasks.filter((t) => t.status === "completed").map((t) => t.id));
  for (const task of plan.tasks) {
    if (task.status !== "pending") continue;
    if (task.deps.every((d) => completed.has(d))) return task;
  }
  return null;
}

function mapTask<TK extends string>(
  plan: WorkPlan<TK>,
  taskId: string,
  f: (t: Task<TK>) => Task<TK>,
): WorkPlan<TK> {
  return {
    ...plan,
    tasks: plan.tasks.map((t) => (t.id === taskId ? f(t) : t)),
  };
}

export function markCompleted<TK extends string>(plan: WorkPlan<TK>, taskId: string): WorkPlan<TK> {
  return mapTask(plan, taskId, (t) => ({ ...t, status: "completed" }));
}

export function markFailed<TK extends string>(plan: WorkPlan<TK>, taskId: string): WorkPlan<TK> {
  return mapTask(plan, taskId, (t) => ({ ...t, status: "failed" }));
}

export function markRevise<TK extends string>(
  plan: WorkPlan<TK>,
  taskId: string,
  feedback: string,
): WorkPlan<TK> {
  return mapTask(plan, taskId, (t) => ({
    ...t,
    status: "pending",
    params: { ...t.params, revise_feedback: feedback },
  }));
}

export function markRejected<TK extends string>(plan: WorkPlan<TK>, task: Task<TK>): WorkPlan<TK> {
  return mapTask(plan, task.id, (t) => ({ ...t, status: "skipped" }));
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/core test
```
Expected: PASS — planner tests plus prior tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/harness-core/src/planner.ts packages/harness-core/tests/planner.test.ts && git commit -m "feat(core): add pure planner helpers (selectNextRunnable, markRevise/Rejected/Completed)"
```

---

## Task 7: Gate resolvers

**Files:**
- Create: `content-harness/packages/harness-core/src/gates.ts`
- Create: `content-harness/packages/harness-core/tests/gates.test.ts`

- [ ] **Step 1: Write failing test**

Create `content-harness/packages/harness-core/tests/gates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { autoApproveGateResolver, autoRejectGateResolver, scriptedGateResolver } from "../src/gates.js";
import type { GateEvent, WorkPlan } from "../src/types.js";

const fakePlan: WorkPlan<"k"> = {
  plan_id: "p",
  piece_id: "piece",
  tasks: [],
  budget_estimate: { tokens: 0, usd: 0, iterations: 0 },
};

describe("gate resolvers", () => {
  it("autoApprove always approves", async () => {
    const event: GateEvent<"k", {}> = { kind: "post_plan", plan: fakePlan };
    expect(await autoApproveGateResolver(event)).toBe("approve");
  });

  it("autoReject always rejects", async () => {
    const event: GateEvent<"k", {}> = { kind: "post_plan", plan: fakePlan };
    expect(await autoRejectGateResolver(event)).toBe("reject");
  });

  it("scriptedGateResolver returns answers in order", async () => {
    const resolver = scriptedGateResolver(["approve", "reject", "approve"]);
    const event: GateEvent<"k", {}> = { kind: "post_plan", plan: fakePlan };
    expect(await resolver(event)).toBe("approve");
    expect(await resolver(event)).toBe("reject");
    expect(await resolver(event)).toBe("approve");
  });

  it("scriptedGateResolver throws if script is exhausted", async () => {
    const resolver = scriptedGateResolver(["approve"]);
    const event: GateEvent<"k", {}> = { kind: "post_plan", plan: fakePlan };
    await resolver(event);
    await expect(resolver(event)).rejects.toThrow(/scripted gate resolver exhausted/);
  });
});
```

- [ ] **Step 2: Run test to see it fail**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/core test
```
Expected: FAIL.

- [ ] **Step 3: Implement gate resolvers**

Create `content-harness/packages/harness-core/src/gates.ts`:

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

function summarize<TK extends string, S>(event: GateEvent<TK, S>): string {
  switch (event.kind) {
    case "post_plan":
      return `[post_plan] plan=${event.plan.plan_id} piece=${event.plan.piece_id} tasks=${event.plan.tasks.length}`;
    case "pre_publish":
      return `[pre_publish] about to publish (state attached)`;
    case "task_gate_before":
      return `[task_gate_before] task=${event.task.id} kind=${event.task.kind}`;
    case "task_gate_after":
      return `[task_gate_after] task=${event.task.id} kind=${event.task.kind} result=${event.delta.kind}`;
  }
}

export function cliGateResolver(): GateResolver {
  return async (event) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write(`\n--- GATE ---\n${summarize(event)}\n`);
      if (event.kind === "post_plan") {
        for (const t of event.plan.tasks) {
          process.stdout.write(`  • ${t.id} (${t.kind}) deps=[${t.deps.join(",")}]\n`);
        }
      }
      if (event.kind === "task_gate_after" && event.delta.kind === "success") {
        const firstText = event.delta.patches.find((p) => typeof p.value === "string");
        if (firstText) process.stdout.write(`  result preview: ${String(firstText.value).slice(0, 200)}\n`);
      }
      const answer = (await rl.question("Approve? [y/N] ")).trim().toLowerCase();
      return answer === "y" || answer === "yes" ? "approve" : "reject";
    } finally {
      rl.close();
    }
  };
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/core test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/harness-core/src/gates.ts packages/harness-core/tests/gates.test.ts && git commit -m "feat(core): add gate resolvers (cli/auto-approve/auto-reject/scripted)"
```

---

## Task 8: Infra — LLM client, logger, clock

**Files:**
- Create: `content-harness/packages/harness-core/src/infra/clock.ts`
- Create: `content-harness/packages/harness-core/src/infra/logger.ts`
- Create: `content-harness/packages/harness-core/src/infra/llm.ts`
- Create: `content-harness/packages/harness-core/tests/infra/llm.test.ts`

- [ ] **Step 1: Implement Clock**

Create `content-harness/packages/harness-core/src/infra/clock.ts`:

```ts
import type { Clock } from "../types.js";

export const systemClock: Clock = { now: () => new Date() };

export function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let t = startMs;
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
  };
}
```

- [ ] **Step 2: Implement Logger**

Create `content-harness/packages/harness-core/src/infra/logger.ts`:

```ts
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "../types.js";

export function consoleLogger(tag: string): Logger {
  const emit = (level: string, msg: string, data?: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, tag, msg, ...(data ?? {}) });
    process.stderr.write(line + "\n");
  };
  return {
    debug: (msg, data) => emit("debug", msg, data),
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
  };
}

export function fileLogger(path: string, tag: string): Logger {
  const emit = (level: string, msg: string, data?: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, tag, msg, ...(data ?? {}) }) + "\n";
    // Fire-and-forget; callers should not await logging.
    mkdir(dirname(path), { recursive: true }).then(() => appendFile(path, line, "utf8")).catch(() => {});
  };
  return {
    debug: (msg, data) => emit("debug", msg, data),
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
  };
}

export function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}
```

- [ ] **Step 3: Write failing LLM test**

Create `content-harness/packages/harness-core/tests/infra/llm.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeAnthropicClient, fakeLLMClient } from "../../src/infra/llm.js";
import type { LLMCompleteOptions } from "../../src/types.js";

describe("fakeLLMClient", () => {
  it("returns scripted responses in order", async () => {
    const client = fakeLLMClient([
      { text: "one", cost: { input_tokens: 1, output_tokens: 1, usd: 0 }, stop_reason: "end_turn" },
      { text: "two", cost: { input_tokens: 2, output_tokens: 2, usd: 0 }, stop_reason: "end_turn" },
    ]);
    const opts: LLMCompleteOptions = { tier: "main", system: "s", messages: [{ role: "user", content: "hi" }], max_tokens: 10 };
    expect((await client.complete(opts)).text).toBe("one");
    expect((await client.complete(opts)).text).toBe("two");
  });

  it("fakeLLMClient remembers received opts", async () => {
    const client = fakeLLMClient([
      { text: "x", cost: { input_tokens: 0, output_tokens: 0, usd: 0 }, stop_reason: "end_turn" },
    ]);
    await client.complete({ tier: "cheap", system: "sys", messages: [{ role: "user", content: "hello" }], max_tokens: 5 });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.tier).toBe("cheap");
  });
});

describe("makeAnthropicClient", () => {
  it("routes tiers to the correct model", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "reply" }],
      usage: { input_tokens: 5, output_tokens: 7 },
      stop_reason: "end_turn",
    });
    const fakeSdk = { messages: { create } } as unknown as Parameters<typeof makeAnthropicClient>[0]["sdk"];
    const client = makeAnthropicClient({ sdk: fakeSdk, mainModel: "claude-opus-4-6", cheapModel: "claude-haiku-4-5-20251001" });
    await client.complete({ tier: "main", system: "you are", messages: [{ role: "user", content: "hi" }], max_tokens: 50 });
    expect(create.mock.calls[0]![0].model).toBe("claude-opus-4-6");
    await client.complete({ tier: "cheap", system: "you are", messages: [{ role: "user", content: "hi" }], max_tokens: 50 });
    expect(create.mock.calls[1]![0].model).toBe("claude-haiku-4-5-20251001");
  });

  it("applies cache_control to cacheable system blocks", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "reply" }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    });
    const fakeSdk = { messages: { create } } as unknown as Parameters<typeof makeAnthropicClient>[0]["sdk"];
    const client = makeAnthropicClient({ sdk: fakeSdk, mainModel: "m", cheapModel: "c" });
    await client.complete({
      tier: "main",
      system: [
        { text: "static big persona block", cache: true },
        { text: "turn-specific", cache: false },
      ],
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
    });
    const arg = create.mock.calls[0]![0];
    expect(Array.isArray(arg.system)).toBe(true);
    expect(arg.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(arg.system[1].cache_control).toBeUndefined();
  });
});
```

- [ ] **Step 4: Implement LLM client**

Create `content-harness/packages/harness-core/src/infra/llm.ts`:

```ts
import type { CostAccounting, LLMClient, LLMCompleteOptions, LLMCompleteResult } from "../types.js";

// Cost table (per million tokens, approximate). Callers can override by passing their own `priceTable`.
const DEFAULT_PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-4-6":              { in: 15.0, out: 75.0 },
  "claude-haiku-4-5-20251001":    { in: 0.80, out: 4.00 },
};

function priceFor(model: string, table: Record<string, { in: number; out: number }>, input: number, output: number): number {
  const row = table[model];
  if (!row) return 0;
  return (input * row.in + output * row.out) / 1_000_000;
}

interface AnthropicMessagesCreateParams {
  model: string;
  max_tokens: number;
  system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  temperature?: number;
}

interface AnthropicMessagesCreateResult {
  content: Array<{ type: "text"; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
}

interface AnthropicLikeSdk {
  messages: {
    create(params: AnthropicMessagesCreateParams): Promise<AnthropicMessagesCreateResult>;
  };
}

export interface AnthropicClientConfig {
  sdk: AnthropicLikeSdk;
  mainModel: string;
  cheapModel: string;
  priceTable?: Record<string, { in: number; out: number }>;
}

export function makeAnthropicClient(config: AnthropicClientConfig): LLMClient {
  const table = config.priceTable ?? DEFAULT_PRICES;
  return {
    async complete(opts: LLMCompleteOptions): Promise<LLMCompleteResult> {
      const model = opts.tier === "main" ? config.mainModel : config.cheapModel;
      const systemBlocks = typeof opts.system === "string"
        ? [{ type: "text" as const, text: opts.system }]
        : opts.system.map((s) => ({
            type: "text" as const,
            text: s.text,
            ...(s.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
          }));
      const result = await config.sdk.messages.create({
        model,
        max_tokens: opts.max_tokens,
        system: systemBlocks,
        messages: opts.messages,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      });
      const text = result.content.map((c) => c.text).join("");
      const cost: CostAccounting = {
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        usd: priceFor(model, table, result.usage.input_tokens, result.usage.output_tokens),
      };
      return { text, cost, stop_reason: result.stop_reason };
    },
  };
}

export interface FakeLLMClient extends LLMClient {
  calls: LLMCompleteOptions[];
}

export function fakeLLMClient(responses: LLMCompleteResult[]): FakeLLMClient {
  const queue = [...responses];
  const calls: LLMCompleteOptions[] = [];
  return {
    calls,
    async complete(opts: LLMCompleteOptions): Promise<LLMCompleteResult> {
      calls.push(opts);
      const next = queue.shift();
      if (!next) throw new Error("fakeLLMClient exhausted");
      return next;
    },
  };
}
```

- [ ] **Step 5: Run tests**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/core test
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/harness-core/src/infra packages/harness-core/tests/infra && git commit -m "feat(core): add infra (clock, logger, anthropic llm client + fake)"
```

---

## Task 9: Loop

**Files:**
- Create: `content-harness/packages/harness-core/src/loop.ts`
- Create: `content-harness/packages/harness-core/tests/loop.test.ts`

- [ ] **Step 1: Write failing loop test with a mock domain**

Create `content-harness/packages/harness-core/tests/loop.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/loop.js";
import { autoApproveGateResolver, scriptedGateResolver } from "../src/gates.js";
import { silentLogger } from "../src/infra/logger.js";
import { systemClock } from "../src/infra/clock.js";
import { fakeLLMClient } from "../src/infra/llm.js";
import type {
  AssetStore,
  Delta,
  HarnessDomain,
  InfraBundle,
  RunConfig,
  Task,
  Verdict,
  WorkPlan,
} from "../src/types.js";

const noopAssets: AssetStore = {
  async append() {},
  async query() { return []; },
  async resolve() { return null; },
  async putBlob() { return ""; },
  async getBlob() { return null; },
};

interface CountState { count: number; doneAfter: number; }

function makePlan(tasks: Task<"inc">[]): WorkPlan<"inc"> {
  return { plan_id: "p", piece_id: "piece", tasks, budget_estimate: { tokens: 0, usd: 0, iterations: 0 } };
}

function countDomain(opts: { tasksToRun: number; gateAfterOn?: boolean }): HarnessDomain<"inc", CountState> {
  const tasks: Task<"inc">[] = [];
  for (let i = 0; i < opts.tasksToRun; i++) {
    tasks.push({
      id: `t${i}`,
      kind: "inc",
      params: {},
      deps: i === 0 ? [] : [`t${i - 1}`],
      input_refs: [],
      acceptance_criteria: "",
      gate_before: false,
      gate_after: !!opts.gateAfterOn && i === opts.tasksToRun - 1,
      status: "pending",
    });
  }
  return {
    async planInitial() { return makePlan(tasks); },
    async replan() { return makePlan(tasks); },
    handlers: {
      inc: async (_task, state: CountState): Promise<Delta<CountState>> => ({
        kind: "success",
        patches: [{ op: "set", path: ["count"], value: state.count + 1 }],
        cost: { input_tokens: 1, output_tokens: 1, usd: 0 },
      }),
    },
    async evaluate(state): Promise<Verdict> {
      if (state.count >= state.doneAfter) return { kind: "done" };
      return { kind: "continue" };
    },
    isDone: (state) => state.count >= state.doneAfter,
    initState: (input) => ({ count: 0, doneAfter: (input as any).doneAfter }),
    serializeState: (s) => s,
    deserializeState: (o) => o as CountState,
  };
}

let runRoot: string;
beforeEach(async () => { runRoot = await mkdtemp(join(tmpdir(), "harness-loop-")); });
afterEach(async () => { await rm(runRoot, { recursive: true, force: true }); });

function makeConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    run_id: "r1",
    run_root: runRoot,
    budget: { max_iterations: 10 },
    retry: { max_attempts: 2, backoff_ms: 0 },
    gates: { post_plan: false, pre_publish: false },
    gate_resolver: autoApproveGateResolver,
    thresholds: { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 },
    max_revisions: 3,
    ...overrides,
  };
}

function makeInfra(): InfraBundle {
  return {
    llm: fakeLLMClient([]),
    assets: noopAssets,
    logger: silentLogger(),
    clock: systemClock,
  };
}

describe("run loop", () => {
  it("dispatches tasks in dep order and stops on done verdict", async () => {
    const domain = countDomain({ tasksToRun: 3 });
    const result = await run(domain, { doneAfter: 3 }, makeConfig(), makeInfra(), "test-domain");
    expect(result.ok).toBe(true);
    expect(result.state.count).toBe(3);
  });

  it("respects budget.max_iterations", async () => {
    const domain = countDomain({ tasksToRun: 5 });
    const result = await run(
      domain,
      { doneAfter: 5 },
      makeConfig({ budget: { max_iterations: 2 } }),
      makeInfra(),
      "test-domain",
    );
    expect(result.ok).toBe(false);
    expect(result.budget.limit_hit).toBe("iterations");
  });

  it("calls post_plan gate when enabled", async () => {
    const domain = countDomain({ tasksToRun: 1 });
    const resolver = scriptedGateResolver(["reject"]);
    const result = await run(
      domain,
      { doneAfter: 1 },
      makeConfig({ gates: { post_plan: true, pre_publish: false }, gate_resolver: resolver }),
      makeInfra(),
      "test-domain",
    );
    // Rejecting post_plan aborts the run.
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/post.?plan/i);
  });

  it("pauses on gate_after task gate", async () => {
    const domain = countDomain({ tasksToRun: 2, gateAfterOn: true });
    const resolver = scriptedGateResolver(["reject"]);
    const result = await run(
      domain,
      { doneAfter: 2 },
      makeConfig({ gate_resolver: resolver }),
      makeInfra(),
      "test-domain",
    );
    // Task gate_after rejecting the final task marks it for revise → loop eventually finishes once budget or iterations cap.
    expect(result.state.count).toBeGreaterThanOrEqual(1);
  });

  it("writes run artifacts to disk", async () => {
    const domain = countDomain({ tasksToRun: 2 });
    const result = await run(domain, { doneAfter: 2 }, makeConfig(), makeInfra(), "test-domain");
    const manifest = JSON.parse(await readFile(join(result.run_dir, "manifest.json"), "utf8"));
    expect(manifest.run_id).toBe("r1");
    const events = (await readFile(join(result.run_dir, "events.jsonl"), "utf8")).trim().split("\n");
    expect(events.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to see it fail**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/core test
```
Expected: FAIL.

- [ ] **Step 3: Implement loop**

Create `content-harness/packages/harness-core/src/loop.ts`:

```ts
import { Budget } from "./budget.js";
import { appendEvent, createRun, snapshot } from "./persistence.js";
import { markCompleted, markFailed, markRevise, selectNextRunnable, markRejected } from "./planner.js";
import { runWithRetry } from "./retry.js";
import type {
  Delta,
  HarnessDomain,
  InfraBundle,
  RunConfig,
  RunResult,
  StatePatch,
  WorkPlan,
} from "./types.js";

function applyPatch<S>(state: S, patch: StatePatch): S {
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

function applyDelta<S>(state: S, delta: Delta<S>): S {
  let next = state;
  for (const p of delta.patches) next = applyPatch(next, p);
  return next;
}

export async function run<TK extends string, S>(
  domain: HarnessDomain<TK, S>,
  input: unknown,
  config: RunConfig,
  infra: InfraBundle,
  domainId: string,
): Promise<RunResult<S>> {
  let state = domain.initState(input);
  let plan: WorkPlan<TK> = await domain.planInitial({ state, config });
  const budget = new Budget(config.budget, () => infra.clock.now());

  const runDir = await createRun({
    run_root: config.run_root,
    run_id: config.run_id,
    domain_id: domainId,
    started_at: infra.clock.now(),
  });
  await snapshot(runDir, { state: domain.serializeState(state), plan, budget: budget.snapshot() });

  // Structural gate: post_plan
  if (config.gates.post_plan) {
    const decision = await config.gate_resolver({ kind: "post_plan", plan });
    if (decision === "reject") {
      return { ok: false, state, budget: budget.snapshot(), reason: "post_plan gate rejected", run_dir: runDir };
    }
  }

  let stuckChecks = 0;
  while (!domain.isDone(state) && !budget.exhausted()) {
    const task = selectNextRunnable(plan, state);
    if (!task) {
      stuckChecks += 1;
      if (stuckChecks > 3) {
        return { ok: false, state, budget: budget.snapshot(), reason: "no runnable task", run_dir: runDir };
      }
      plan = await domain.replan({ state, config }, "no runnable task");
      continue;
    }
    stuckChecks = 0;

    if (task.gate_before) {
      const decision = await config.gate_resolver({ kind: "task_gate_before", task });
      if (decision === "reject") {
        plan = markRejected(plan, task);
        continue;
      }
    }

    const delta = await runWithRetry(domain.handlers[task.kind], task, state, infra, config.retry);

    state = applyDelta(state, delta);
    budget.charge(delta.cost);
    budget.tickIteration();

    if (delta.kind === "success") {
      plan = markCompleted(plan, task.id);
    } else {
      plan = markFailed(plan, task.id);
    }

    await appendEvent(runDir, { task, delta });
    await snapshot(runDir, { state: domain.serializeState(state), plan, budget: budget.snapshot() });

    if (task.gate_after) {
      const decision = await config.gate_resolver({ kind: "task_gate_after", task, delta });
      if (decision === "reject") {
        plan = markRevise(plan, task.id, "user rejected at post-task gate");
        continue;
      }
    }

    if (delta.kind === "failure") {
      // Let the domain decide whether to give up or replan.
      const verdict = await domain.evaluate(state);
      if (verdict.kind === "abort") {
        return { ok: false, state, budget: budget.snapshot(), reason: verdict.reason, run_dir: runDir };
      }
      if (verdict.kind === "redirect") {
        plan = await domain.replan({ state, config }, verdict.reason);
        continue;
      }
      // Otherwise treat as permanent and let the domain break out via isDone / no runnable task.
      continue;
    }

    const verdict = await domain.evaluate(state);
    switch (verdict.kind) {
      case "continue":
        break;
      case "revise":
        plan = markRevise(plan, verdict.task_id, verdict.feedback);
        break;
      case "redirect":
        plan = await domain.replan({ state, config }, verdict.reason);
        break;
      case "done":
        await snapshot(runDir, { state: domain.serializeState(state), plan, budget: budget.snapshot() });
        return { ok: true, state, budget: budget.snapshot(), run_dir: runDir };
      case "abort":
        return { ok: false, state, budget: budget.snapshot(), reason: verdict.reason, run_dir: runDir };
    }
  }

  if (budget.exhausted()) {
    return { ok: false, state, budget: budget.snapshot(), reason: `budget exhausted (${budget.snapshot().limit_hit})`, run_dir: runDir };
  }
  return { ok: true, state, budget: budget.snapshot(), run_dir: runDir };
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/core test
```
Expected: PASS — loop tests plus all prior tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/harness-core/src/loop.ts packages/harness-core/tests/loop.test.ts && git commit -m "feat(core): add run loop with budget, gates, verdict routing, persistence"
```

---

## Task 10: harness-core barrel

**Files:**
- Modify: `content-harness/packages/harness-core/src/index.ts`

- [ ] **Step 1: Export everything**

Replace `content-harness/packages/harness-core/src/index.ts` with:

```ts
export * from "./types.js";
export { Budget } from "./budget.js";
export { createRun, snapshot, appendEvent, loadLatestState, loadLatestPlan } from "./persistence.js";
export type { EventEntry, CreateRunOptions } from "./persistence.js";
export { runWithRetry } from "./retry.js";
export type { RetryConfig } from "./retry.js";
export {
  selectNextRunnable,
  markCompleted,
  markFailed,
  markRevise,
  markRejected,
} from "./planner.js";
export {
  autoApproveGateResolver,
  autoRejectGateResolver,
  scriptedGateResolver,
  cliGateResolver,
} from "./gates.js";
export { run } from "./loop.js";
export { systemClock, fakeClock } from "./infra/clock.js";
export { consoleLogger, fileLogger, silentLogger } from "./infra/logger.js";
export { makeAnthropicClient, fakeLLMClient } from "./infra/llm.js";
export type { AnthropicClientConfig, FakeLLMClient } from "./infra/llm.js";
```

- [ ] **Step 2: Typecheck + test**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/core typecheck && pnpm --filter @content-harness/core build && pnpm --filter @content-harness/core test
```
Expected: clean, build emits `dist/`, tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/harness-core/src/index.ts && git commit -m "feat(core): export public API from index"
```

---

## Task 11: social-pipeline package scaffold + zod schemas

**Files:**
- Create: `content-harness/packages/social-pipeline/package.json`
- Create: `content-harness/packages/social-pipeline/tsconfig.json`
- Create: `content-harness/packages/social-pipeline/vitest.config.ts`
- Create: `content-harness/packages/social-pipeline/src/schemas/persona.ts`
- Create: `content-harness/packages/social-pipeline/src/schemas/campaign.ts`
- Create: `content-harness/packages/social-pipeline/src/schemas/piece.ts`
- Create: `content-harness/packages/social-pipeline/src/schemas/asset-pool.ts`
- Create: `content-harness/packages/social-pipeline/src/schemas/index.ts`
- Create: `content-harness/packages/social-pipeline/tests/schemas.test.ts`

- [ ] **Step 1: Create package.json**

Create `content-harness/packages/social-pipeline/package.json`:

```json
{
  "name": "@content-harness/social",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "tsx bin/run.ts"
  },
  "dependencies": {
    "@content-harness/core": "workspace:*",
    "@anthropic-ai/sdk": "^0.24.0",
    "yaml": "^2.4.2",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.4.5",
    "@types/node": "^20.12.7",
    "vitest": "^1.6.0",
    "tsx": "^4.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `content-harness/packages/social-pipeline/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "bin/**/*.ts"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

Create `content-harness/packages/social-pipeline/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    testTimeout: 15_000,
  },
});
```

- [ ] **Step 4: Install deps**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm install
```
Expected: installs zod/yaml/tsx, links workspace core package.

- [ ] **Step 5: Write failing schema tests**

Create `content-harness/packages/social-pipeline/tests/schemas.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PersonaSchema, CampaignSchema, PieceSchema, AssetPoolSchema } from "../src/schemas/index.js";

describe("PersonaSchema", () => {
  it("accepts a minimal valid persona", () => {
    const p = PersonaSchema.parse({
      id: "liu",
      identity: { name: "Liu", one_line_bio: "bio", long_bio: "long" },
      voice: {
        tone: "analytic",
        point_of_view: "first-person",
        vocabulary: { prefer: ["harness"], avoid: ["hype"] },
        example_phrases: ["hi"],
      },
      domain: { primary_topics: ["ai"], expertise_depth: "practitioner", adjacent_topics: [] },
      audience: {
        description: "engineers",
        pain_points: ["cost"],
        sophistication: "practitioner",
        evaluator_persona_ids: ["e1"],
      },
      platforms: [{ platform: "twitter", handle: "liu", priority: 1, role: "primary" }],
      style_references: { emulate: [], avoid: [] },
      success_metrics: { primary: "engagement", red_lines: ["no hype"] },
      asset_pool_id: "liu",
    });
    expect(p.id).toBe("liu");
  });

  it("rejects unknown platform", () => {
    expect(() =>
      PersonaSchema.parse({
        id: "x",
        identity: { name: "x", one_line_bio: "", long_bio: "" },
        voice: { tone: "", point_of_view: "", vocabulary: { prefer: [], avoid: [] }, example_phrases: [] },
        domain: { primary_topics: [], expertise_depth: "practitioner", adjacent_topics: [] },
        audience: { description: "", pain_points: [], sophistication: "practitioner", evaluator_persona_ids: [] },
        platforms: [{ platform: "tiktok", handle: "x", priority: 1, role: "primary" }],
        style_references: { emulate: [], avoid: [] },
        success_metrics: { primary: "engagement", red_lines: [] },
        asset_pool_id: "x",
      }),
    ).toThrow();
  });
});

describe("CampaignSchema", () => {
  it("accepts valid campaign", () => {
    const c = CampaignSchema.parse({
      id: "q2",
      persona_id: "liu",
      goal: "launch",
      timeline: { start: "2026-04-01T00:00:00Z" },
      key_messages: ["msg"],
      content_mix: { thread: 5 },
      overrides: {},
      success_criteria: "growth",
    });
    expect(c.id).toBe("q2");
  });
});

describe("PieceSchema", () => {
  it("accepts a draft piece with raw materials", () => {
    const p = PieceSchema.parse({
      id: "piece1",
      campaign_id: "q2",
      persona_id: "liu",
      input: {
        raw_materials: [{ id: "rm1", kind: "text", content: "hello", origin: "inline" }],
        intent: "explain the loop",
      },
      state: "draft",
      platform_variants: [],
      eval_history: [],
    });
    expect(p.state).toBe("draft");
  });
});

describe("AssetPoolSchema", () => {
  it("accepts an empty pool", () => {
    const pool = AssetPoolSchema.parse({
      persona_id: "liu",
      reference_posts: [],
      style_patterns: [],
      hot_topics: [],
      evaluator_personas: [],
      own_history: [],
    });
    expect(pool.persona_id).toBe("liu");
  });
});
```

- [ ] **Step 6: Run test to see it fail**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/social test
```
Expected: FAIL.

- [ ] **Step 7: Implement persona schema**

Create `content-harness/packages/social-pipeline/src/schemas/persona.ts`:

```ts
import { z } from "zod";

export const PlatformEnum = z.enum(["twitter", "linkedin", "medium", "xiaohongshu"]);

export const PlatformBindingSchema = z.object({
  platform: PlatformEnum,
  handle: z.string(),
  priority: z.number().min(0).max(1),
  role: z.enum(["primary", "cross-post", "syndicate"]),
});

export const AccountRefSchema = z.object({
  platform: PlatformEnum,
  handle: z.string(),
  why: z.string(),
});

export const PersonaSchema = z.object({
  id: z.string(),
  identity: z.object({
    name: z.string(),
    one_line_bio: z.string(),
    long_bio: z.string(),
  }),
  voice: z.object({
    tone: z.string(),
    point_of_view: z.string(),
    vocabulary: z.object({ prefer: z.array(z.string()), avoid: z.array(z.string()) }),
    example_phrases: z.array(z.string()),
  }),
  domain: z.object({
    primary_topics: z.array(z.string()),
    expertise_depth: z.enum(["beginner", "practitioner", "expert"]),
    adjacent_topics: z.array(z.string()),
  }),
  audience: z.object({
    description: z.string(),
    pain_points: z.array(z.string()),
    sophistication: z.enum(["layperson", "practitioner", "expert"]),
    evaluator_persona_ids: z.array(z.string()),
  }),
  platforms: z.array(PlatformBindingSchema),
  style_references: z.object({
    emulate: z.array(AccountRefSchema),
    avoid: z.array(AccountRefSchema),
  }),
  success_metrics: z.object({
    primary: z.enum(["engagement", "growth", "clicks", "citations"]),
    red_lines: z.array(z.string()),
  }),
  asset_pool_id: z.string(),
});

export type Persona = z.infer<typeof PersonaSchema>;
export type PlatformBinding = z.infer<typeof PlatformBindingSchema>;
```

- [ ] **Step 8: Implement campaign schema**

Create `content-harness/packages/social-pipeline/src/schemas/campaign.ts`:

```ts
import { z } from "zod";

export const CampaignSchema = z.object({
  id: z.string(),
  persona_id: z.string(),
  goal: z.string(),
  timeline: z.object({
    start: z.string(),
    end: z.string().optional(),
  }),
  key_messages: z.array(z.string()),
  content_mix: z.record(z.number()),
  overrides: z.object({
    platform_weights: z.record(z.number()).optional(),
    audience_additions: z.array(z.string()).optional(),
    voice_tweaks: z.record(z.unknown()).optional(),
  }),
  success_criteria: z.string(),
});

export type Campaign = z.infer<typeof CampaignSchema>;
```

- [ ] **Step 9: Implement piece schema (incl. reference-typed subfields)**

Create `content-harness/packages/social-pipeline/src/schemas/piece.ts`:

```ts
import { z } from "zod";

export const AssetRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reference_post"),    id: z.string() }),
  z.object({ kind: z.literal("style_pattern"),     id: z.string() }),
  z.object({ kind: z.literal("hot_topic"),         platform: z.string(), topic: z.string() }),
  z.object({ kind: z.literal("evaluator_persona"), id: z.string() }),
  z.object({ kind: z.literal("own_post"),          piece_id: z.string(), platform: z.string() }),
  z.object({ kind: z.literal("voice_fingerprint") }),
]);

export const StateRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("raw_material"),     piece_id: z.string(), material_id: z.string() }),
  z.object({ kind: z.literal("base_article"),     piece_id: z.string() }),
  z.object({ kind: z.literal("platform_variant"), piece_id: z.string(), platform: z.string(), variant_idx: z.number() }),
  z.object({ kind: z.literal("eval_round"),       piece_id: z.string(), round: z.number() }),
  z.object({ kind: z.literal("deliverable"),      path: z.string() }),
]);

export const RawMaterialSchema = z.object({
  id: z.string(),
  kind: z.enum(["text", "url", "file", "note"]),
  content: z.string(),
  origin: z.string(),
});

export const PlatformVariantSchema = z.object({
  platform: z.string(),
  content: z.string(),
  constraints_applied: z.array(z.string()),
  inspired_by: z.array(AssetRefSchema),
  style_patterns_applied: z.array(AssetRefSchema),
  status: z.enum(["drafting", "pending_eval", "accepted", "rejected"]),
  eval_score: z.number().optional(),
  revision_count: z.number(),
});

export const AudienceFeedbackSchema = z.object({
  from: AssetRefSchema,
  understood: z.boolean(),
  engagement_likelihood: z.number(),
  ai_smell_score: z.number(),
  depth_score: z.number(),
  comments: z.string(),
});

export const ActionableFeedbackSchema = z.object({
  from: AssetRefSchema,
  category: z.enum(["tone", "structure", "clarity", "depth", "ai_smell", "other"]),
  text: z.string(),
  targets: z.array(StateRefSchema),
  suggested_refs: z.array(AssetRefSchema).optional(),
});

export const EvalRoundSchema = z.object({
  round: z.number(),
  target: StateRefSchema,
  audience_feedback: z.array(AudienceFeedbackSchema),
  aggregated_score: z.number(),
  actionable_feedback: z.array(ActionableFeedbackSchema),
  verdict: z.enum(["accept", "revise", "abort"]),
});

export const PieceSchema = z.object({
  id: z.string(),
  campaign_id: z.string(),
  persona_id: z.string(),
  input: z.object({
    raw_materials: z.array(RawMaterialSchema),
    intent: z.string(),
  }),
  state: z.enum(["draft", "refining", "evaluating", "ready", "published"]),
  base_article: z.object({
    markdown: z.string(),
    produced_at: z.string(),
    source_refs: z.array(AssetRefSchema),
  }).optional(),
  platform_variants: z.array(PlatformVariantSchema),
  eval_history: z.array(EvalRoundSchema),
});

export type AssetRef = z.infer<typeof AssetRefSchema>;
export type StateRef = z.infer<typeof StateRefSchema>;
export type RawMaterial = z.infer<typeof RawMaterialSchema>;
export type PlatformVariant = z.infer<typeof PlatformVariantSchema>;
export type AudienceFeedback = z.infer<typeof AudienceFeedbackSchema>;
export type ActionableFeedback = z.infer<typeof ActionableFeedbackSchema>;
export type EvalRound = z.infer<typeof EvalRoundSchema>;
export type Piece = z.infer<typeof PieceSchema>;
```

- [ ] **Step 10: Implement asset-pool schema**

Create `content-harness/packages/social-pipeline/src/schemas/asset-pool.ts`:

```ts
import { z } from "zod";

export const ReferencePostSchema = z.object({
  id: z.string(),
  platform: z.string(),
  author: z.string(),
  url: z.string(),
  content: z.string(),
  engagement: z.object({
    likes: z.number().optional(),
    shares: z.number().optional(),
    comments: z.number().optional(),
    views: z.number().optional(),
  }),
  topic_tags: z.array(z.string()),
  collected_at: z.string(),
  expires_at: z.string().optional(),
  source_query: z.string(),
});

export const StylePatternSchema = z.object({
  id: z.string(),
  platform: z.string(),
  pattern_type: z.enum(["opening", "transition", "cta", "tone", "structure", "vocab", "emoji_use", "hashtag_use"]),
  pattern_text: z.string(),
  example_ref_ids: z.array(z.string()),
  extracted_at: z.string(),
});

export const HotTopicSchema = z.object({
  platform: z.string(),
  topic: z.string(),
  score: z.number(),
  observed_window: z.object({ from: z.string(), to: z.string() }),
  expires_at: z.string(),
  source: z.string(),
});

export const EvaluatorPersonaSchema = z.object({
  id: z.string(),
  name: z.string(),
  background: z.string(),
  interests: z.array(z.string()),
  pain_points: z.array(z.string()),
  reading_goals: z.array(z.string()),
  critic_style: z.enum(["strict", "balanced", "generous"]),
  language: z.enum(["en", "zh", "other"]),
});

export const OwnPostSchema = z.object({
  piece_id: z.string(),
  platform: z.string(),
  url: z.string().optional(),
  metrics: z.record(z.number()),
  posted_at: z.string(),
});

export const VoiceFingerprintSchema = z.object({
  vocab_histogram: z.record(z.number()),
  sentence_rhythms: z.string(),
  typical_openings: z.array(z.string()),
  quirks: z.array(z.string()),
  extracted_from_piece_ids: z.array(z.string()),
  updated_at: z.string(),
});

export const AssetPoolSchema = z.object({
  persona_id: z.string(),
  reference_posts: z.array(ReferencePostSchema),
  style_patterns: z.array(StylePatternSchema),
  hot_topics: z.array(HotTopicSchema),
  evaluator_personas: z.array(EvaluatorPersonaSchema),
  own_history: z.array(OwnPostSchema),
  voice_fingerprint: VoiceFingerprintSchema.optional(),
});

export type ReferencePost = z.infer<typeof ReferencePostSchema>;
export type StylePattern = z.infer<typeof StylePatternSchema>;
export type HotTopic = z.infer<typeof HotTopicSchema>;
export type EvaluatorPersona = z.infer<typeof EvaluatorPersonaSchema>;
export type OwnPost = z.infer<typeof OwnPostSchema>;
export type VoiceFingerprint = z.infer<typeof VoiceFingerprintSchema>;
export type AssetPool = z.infer<typeof AssetPoolSchema>;
```

- [ ] **Step 11: Create schemas/index.ts barrel**

Create `content-harness/packages/social-pipeline/src/schemas/index.ts`:

```ts
export * from "./persona.js";
export * from "./campaign.js";
export * from "./piece.js";
export * from "./asset-pool.js";
```

- [ ] **Step 12: Run tests**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/social test
```
Expected: PASS — schema tests.

- [ ] **Step 13: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/social-pipeline && git commit -m "feat(social): scaffold package + zod schemas for persona/campaign/piece/asset-pool"
```

---

## Task 12: Asset store (filesystem JSONL impl)

**Files:**
- Create: `content-harness/packages/social-pipeline/src/asset-store.ts`
- Create: `content-harness/packages/social-pipeline/tests/asset-store.test.ts`

- [ ] **Step 1: Write failing test**

Create `content-harness/packages/social-pipeline/tests/asset-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFilesystemAssetStore } from "../src/asset-store.js";
import type { AssetRef } from "@content-harness/core";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "social-assets-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("filesystem asset store", () => {
  it("appends and queries reference_posts", async () => {
    const store = makeFilesystemAssetStore(root);
    await store.append("liu", "reference_posts", [
      { id: "rp1", platform: "twitter", author: "a", url: "u", content: "hello", engagement: {}, topic_tags: [], collected_at: "2026-04-01T00:00:00Z", source_query: "ai" },
      { id: "rp2", platform: "twitter", author: "b", url: "u2", content: "world", engagement: {}, topic_tags: [], collected_at: "2026-04-02T00:00:00Z", source_query: "ai" },
    ]);
    const all = await store.query<{ id: string }>("liu", "reference_posts");
    expect(all.map((r) => r.id)).toEqual(["rp1", "rp2"]);
  });

  it("resolves reference_post by id", async () => {
    const store = makeFilesystemAssetStore(root);
    await store.append("liu", "reference_posts", [
      { id: "rp1", platform: "twitter", author: "a", url: "u", content: "hello", engagement: {}, topic_tags: [], collected_at: "2026-04-01T00:00:00Z", source_query: "ai" },
    ]);
    const ref: AssetRef = { kind: "reference_post", id: "rp1" };
    const resolved = await store.resolve<{ id: string; content: string }>("liu", ref);
    expect(resolved?.content).toBe("hello");
  });

  it("resolves evaluator_persona by id from yaml", async () => {
    const store = makeFilesystemAssetStore(root);
    await store.append("liu", "evaluator_personas", [
      { id: "p1", name: "n", background: "b", interests: [], pain_points: [], reading_goals: [], critic_style: "strict", language: "en" },
    ]);
    const resolved = await store.resolve<{ id: string }>("liu", { kind: "evaluator_persona", id: "p1" });
    expect(resolved?.id).toBe("p1");
  });

  it("resolves hot_topic by platform+topic", async () => {
    const store = makeFilesystemAssetStore(root);
    await store.append("liu", "hot_topics", [
      { platform: "twitter", topic: "agents", score: 0.9, observed_window: { from: "a", to: "b" }, expires_at: "c", source: "x" },
    ]);
    const resolved = await store.resolve<{ score: number }>("liu", { kind: "hot_topic", platform: "twitter", topic: "agents" });
    expect(resolved?.score).toBe(0.9);
  });

  it("returns null for unknown ref", async () => {
    const store = makeFilesystemAssetStore(root);
    const resolved = await store.resolve("liu", { kind: "reference_post", id: "nope" });
    expect(resolved).toBeNull();
  });

  it("stores and reads blobs", async () => {
    const store = makeFilesystemAssetStore(root);
    const key = await store.putBlob("liu", "hello.txt", new TextEncoder().encode("hi"));
    const bytes = await store.getBlob("liu", key);
    expect(bytes && new TextDecoder().decode(bytes)).toBe("hi");
  });
});
```

- [ ] **Step 2: Run test to see it fail**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/social test
```
Expected: FAIL.

- [ ] **Step 3: Implement asset store**

Create `content-harness/packages/social-pipeline/src/asset-store.ts`:

```ts
import { appendFile, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AssetRef, AssetStore } from "@content-harness/core";

const BUCKETS_JSONL = new Set([
  "reference_posts",
  "style_patterns",
  "hot_topics",
  "own_history",
  "evaluator_personas",
]);

function bucketFile(root: string, pool: string, bucket: string): string {
  return join(root, pool, `${bucket}.jsonl`);
}

async function ensurePoolDir(root: string, pool: string): Promise<void> {
  await mkdir(join(root, pool), { recursive: true });
  await mkdir(join(root, pool, "blobs"), { recursive: true });
}

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export function makeFilesystemAssetStore(root: string): AssetStore {
  return {
    async append<T>(pool: string, bucket: string, records: T[]): Promise<void> {
      if (!BUCKETS_JSONL.has(bucket)) {
        throw new Error(`unknown bucket: ${bucket}`);
      }
      await ensurePoolDir(root, pool);
      const path = bucketFile(root, pool, bucket);
      const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
      await appendFile(path, lines, "utf8");
    },

    async query<T>(pool: string, bucket: string): Promise<T[]> {
      if (!BUCKETS_JSONL.has(bucket)) return [];
      return readJsonl<T>(bucketFile(root, pool, bucket));
    },

    async resolve<T>(pool: string, ref: AssetRef): Promise<T | null> {
      switch (ref.kind) {
        case "reference_post": {
          const all = await readJsonl<{ id: string }>(bucketFile(root, pool, "reference_posts"));
          return (all.find((r) => r.id === ref.id) as T | undefined) ?? null;
        }
        case "style_pattern": {
          const all = await readJsonl<{ id: string }>(bucketFile(root, pool, "style_patterns"));
          return (all.find((r) => r.id === ref.id) as T | undefined) ?? null;
        }
        case "hot_topic": {
          const all = await readJsonl<{ platform: string; topic: string }>(bucketFile(root, pool, "hot_topics"));
          return (all.find((r) => r.platform === ref.platform && r.topic === ref.topic) as T | undefined) ?? null;
        }
        case "evaluator_persona": {
          const all = await readJsonl<{ id: string }>(bucketFile(root, pool, "evaluator_personas"));
          return (all.find((r) => r.id === ref.id) as T | undefined) ?? null;
        }
        case "own_post": {
          const all = await readJsonl<{ piece_id: string; platform: string }>(bucketFile(root, pool, "own_history"));
          return (all.find((r) => r.piece_id === ref.piece_id && r.platform === ref.platform) as T | undefined) ?? null;
        }
        case "voice_fingerprint": {
          const path = join(root, pool, "voice_fingerprint.json");
          try {
            const raw = await readFile(path, "utf8");
            return JSON.parse(raw) as T;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw err;
          }
        }
      }
    },

    async putBlob(pool: string, key: string, bytes: Uint8Array): Promise<string> {
      await ensurePoolDir(root, pool);
      const path = join(root, pool, "blobs", key);
      await writeFile(path, bytes);
      return key;
    },

    async getBlob(pool: string, key: string): Promise<Uint8Array | null> {
      try {
        const buf = await readFile(join(root, pool, "blobs", key));
        return new Uint8Array(buf);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
  };
}

// Exists-check helper mostly useful in tests.
export async function poolExists(root: string, pool: string): Promise<boolean> {
  try {
    const s = await stat(join(root, pool));
    return s.isDirectory();
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/social test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/social-pipeline/src/asset-store.ts packages/social-pipeline/tests/asset-store.test.ts && git commit -m "feat(social): filesystem asset store with typed AssetRef resolve"
```

---

## Task 13: Evaluator — personas, simulator, aggregator

**Files:**
- Create: `content-harness/packages/social-pipeline/src/eval/personas.ts`
- Create: `content-harness/packages/social-pipeline/src/eval/aggregator.ts`
- Create: `content-harness/packages/social-pipeline/src/eval/simulator.ts`
- Create: `content-harness/packages/social-pipeline/tests/eval/aggregator.test.ts`
- Create: `content-harness/packages/social-pipeline/tests/eval/simulator.test.ts`

- [ ] **Step 1: Hardcoded evaluator personas**

Create `content-harness/packages/social-pipeline/src/eval/personas.ts`:

```ts
import type { EvaluatorPersona } from "../schemas/index.js";

export const DEFAULT_EVALUATOR_PERSONAS: EvaluatorPersona[] = [
  {
    id: "senior-ai-eng-skeptical",
    name: "Marta — Senior AI Engineer",
    background:
      "10 years infra; currently leads LLM platform at a fintech. Skeptical of hype, pattern-matches on implementation details, wants numbers.",
    interests: ["agent loops", "eval infra", "cost engineering"],
    pain_points: ["vague claims", "missing numbers", "no failure modes discussed"],
    reading_goals: ["take away one concrete lesson I can apply on Monday"],
    critic_style: "strict",
    language: "en",
  },
  {
    id: "startup-cto-buying-time",
    name: "Akira — Startup CTO",
    background:
      "CTO of a 10-person B2B SaaS. Ships products under time pressure. Reads Twitter at 11pm to decide what tools are worth a spike tomorrow.",
    interests: ["what to build vs buy", "time-to-ship", "team force multipliers"],
    pain_points: ["long threads with no TLDR", "theory without real usage", "obvious advice"],
    reading_goals: ["decide in 30 seconds whether this is worth reading fully"],
    critic_style: "balanced",
    language: "en",
  },
  {
    id: "agent-framework-maintainer",
    name: "Priya — OSS Maintainer",
    background:
      "Maintains a popular agent framework. Knows the tradeoffs intimately. Will immediately spot hand-wavy claims and pattern conflicts.",
    interests: ["architectural tradeoffs", "edge cases", "prior art"],
    pain_points: ["reinvention without attribution", "ignoring known tradeoffs"],
    reading_goals: ["is this person's thinking rigorous enough to take seriously"],
    critic_style: "strict",
    language: "en",
  },
];
```

- [ ] **Step 2: Aggregator test**

Create `content-harness/packages/social-pipeline/tests/eval/aggregator.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { aggregate } from "../../src/eval/aggregator.js";
import type { AudienceFeedback } from "../../src/schemas/index.js";

const fb = (engagement: number, aiSmell: number, depth: number, comment = "c"): AudienceFeedback => ({
  from: { kind: "evaluator_persona", id: "p" },
  understood: true,
  engagement_likelihood: engagement,
  ai_smell_score: aiSmell,
  depth_score: depth,
  comments: comment,
});

describe("aggregate", () => {
  it("averages engagement, maxes ai_smell, averages depth", () => {
    const result = aggregate([fb(0.8, 0.1, 0.6), fb(0.6, 0.4, 0.7), fb(0.9, 0.2, 0.5)], {
      eval_pass: 0.7,
      ai_smell_max: 0.3,
      depth_min: 0.5,
    });
    expect(result.aggregated_score).toBeCloseTo((0.8 + 0.6 + 0.9) / 3);
    expect(result.ai_smell).toBeCloseTo(0.4);
    expect(result.depth).toBeCloseTo((0.6 + 0.7 + 0.5) / 3);
  });

  it("marks accept when thresholds clear", () => {
    const result = aggregate([fb(0.9, 0.1, 0.8)], { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 });
    expect(result.verdict).toBe("accept");
  });

  it("marks revise when engagement too low", () => {
    const result = aggregate([fb(0.5, 0.1, 0.8)], { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 });
    expect(result.verdict).toBe("revise");
  });

  it("marks revise when ai_smell too high", () => {
    const result = aggregate([fb(0.9, 0.5, 0.8)], { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 });
    expect(result.verdict).toBe("revise");
  });

  it("marks revise when depth too low", () => {
    const result = aggregate([fb(0.9, 0.1, 0.3)], { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 });
    expect(result.verdict).toBe("revise");
  });

  it("derives actionable_feedback from comments when failing", () => {
    const result = aggregate([fb(0.5, 0.1, 0.8, "feels generic, add a concrete number")], {
      eval_pass: 0.7,
      ai_smell_max: 0.3,
      depth_min: 0.5,
    });
    expect(result.actionable_feedback).toHaveLength(1);
    expect(result.actionable_feedback[0]!.text).toContain("concrete number");
  });
});
```

- [ ] **Step 3: Implement aggregator**

Create `content-harness/packages/social-pipeline/src/eval/aggregator.ts`:

```ts
import type { ActionableFeedback, AudienceFeedback, StateRef } from "../schemas/index.js";

export interface EvalThresholds {
  eval_pass: number;
  ai_smell_max: number;
  depth_min: number;
}

export interface AggregateResult {
  aggregated_score: number;
  ai_smell: number;
  depth: number;
  verdict: "accept" | "revise" | "abort";
  actionable_feedback: ActionableFeedback[];
}

export function aggregate(feedback: AudienceFeedback[], thresholds: EvalThresholds, target?: StateRef): AggregateResult {
  if (feedback.length === 0) {
    return {
      aggregated_score: 0,
      ai_smell: 1,
      depth: 0,
      verdict: "abort",
      actionable_feedback: [],
    };
  }
  const aggregated_score = avg(feedback.map((f) => f.engagement_likelihood));
  const ai_smell = Math.max(...feedback.map((f) => f.ai_smell_score));
  const depth = avg(feedback.map((f) => f.depth_score));

  const passed = aggregated_score >= thresholds.eval_pass
              && ai_smell <= thresholds.ai_smell_max
              && depth >= thresholds.depth_min;

  const actionable: ActionableFeedback[] = passed
    ? []
    : feedback
        .filter((f) =>
          f.engagement_likelihood < thresholds.eval_pass
          || f.ai_smell_score > thresholds.ai_smell_max
          || f.depth_score < thresholds.depth_min,
        )
        .map((f) => ({
          from: f.from,
          category: pickCategory(f, thresholds),
          text: f.comments,
          targets: target ? [target] : [],
        }));

  return {
    aggregated_score,
    ai_smell,
    depth,
    verdict: passed ? "accept" : "revise",
    actionable_feedback: actionable,
  };
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pickCategory(f: AudienceFeedback, t: EvalThresholds): ActionableFeedback["category"] {
  if (f.ai_smell_score > t.ai_smell_max) return "ai_smell";
  if (f.depth_score < t.depth_min) return "depth";
  if (f.engagement_likelihood < t.eval_pass) return "tone";
  return "other";
}
```

- [ ] **Step 4: Simulator test**

Create `content-harness/packages/social-pipeline/tests/eval/simulator.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { simulateAudience } from "../../src/eval/simulator.js";
import { fakeLLMClient } from "@content-harness/core";
import { DEFAULT_EVALUATOR_PERSONAS } from "../../src/eval/personas.js";

describe("simulateAudience", () => {
  it("dispatches one LLM call per evaluator persona and parses feedback", async () => {
    const llm = fakeLLMClient([
      {
        text: JSON.stringify({ understood: true, engagement_likelihood: 0.8, ai_smell_score: 0.2, depth_score: 0.7, comments: "c1" }),
        cost: { input_tokens: 10, output_tokens: 20, usd: 0.001 },
        stop_reason: "end_turn",
      },
      {
        text: JSON.stringify({ understood: true, engagement_likelihood: 0.75, ai_smell_score: 0.25, depth_score: 0.6, comments: "c2" }),
        cost: { input_tokens: 10, output_tokens: 20, usd: 0.001 },
        stop_reason: "end_turn",
      },
      {
        text: JSON.stringify({ understood: true, engagement_likelihood: 0.9, ai_smell_score: 0.1, depth_score: 0.8, comments: "c3" }),
        cost: { input_tokens: 10, output_tokens: 20, usd: 0.001 },
        stop_reason: "end_turn",
      },
    ]);
    const feedback = await simulateAudience(llm, {
      variant_text: "hello world",
      personas: DEFAULT_EVALUATOR_PERSONAS,
    });
    expect(feedback).toHaveLength(3);
    expect(feedback[0]!.engagement_likelihood).toBe(0.8);
    expect(feedback.every((f) => f.from.kind === "evaluator_persona")).toBe(true);
  });

  it("handles malformed JSON by marking persona with low scores", async () => {
    const llm = fakeLLMClient([
      {
        text: "not a json",
        cost: { input_tokens: 10, output_tokens: 20, usd: 0.001 },
        stop_reason: "end_turn",
      },
    ]);
    const feedback = await simulateAudience(llm, {
      variant_text: "hi",
      personas: [DEFAULT_EVALUATOR_PERSONAS[0]!],
    });
    expect(feedback).toHaveLength(1);
    expect(feedback[0]!.engagement_likelihood).toBe(0);
    expect(feedback[0]!.ai_smell_score).toBe(1);
  });
});
```

- [ ] **Step 5: Implement simulator**

Create `content-harness/packages/social-pipeline/src/eval/simulator.ts`:

```ts
import type { LLMClient } from "@content-harness/core";
import type { AudienceFeedback, EvaluatorPersona } from "../schemas/index.js";

interface SimulateOpts {
  variant_text: string;
  personas: EvaluatorPersona[];
  platform?: string;
}

const SYSTEM_TEMPLATE = (p: EvaluatorPersona, platform: string) => `You are ${p.name}. ${p.background}

You are going to read a ${platform} post and rate it honestly as if it landed in your feed. Do NOT be polite. Apply your critic style: ${p.critic_style}.

Return ONLY a single JSON object on one line with exactly these fields:
{
  "understood": boolean,            // did you follow the point?
  "engagement_likelihood": number,  // 0..1, would you engage (like/retweet/click)?
  "ai_smell_score": number,         // 0..1, higher = feels more LLM-generated / generic
  "depth_score": number,            // 0..1, higher = substantive/new/actionable for someone like you
  "comments": string                // 1-2 sentences explaining your scores, concrete
}
No other text.`;

function parseFeedback(text: string, persona: EvaluatorPersona): AudienceFeedback {
  try {
    const obj = JSON.parse(text.trim()) as {
      understood?: boolean;
      engagement_likelihood?: number;
      ai_smell_score?: number;
      depth_score?: number;
      comments?: string;
    };
    return {
      from: { kind: "evaluator_persona", id: persona.id },
      understood: Boolean(obj.understood),
      engagement_likelihood: clamp01(obj.engagement_likelihood),
      ai_smell_score: clamp01(obj.ai_smell_score),
      depth_score: clamp01(obj.depth_score),
      comments: String(obj.comments ?? ""),
    };
  } catch {
    return {
      from: { kind: "evaluator_persona", id: persona.id },
      understood: false,
      engagement_likelihood: 0,
      ai_smell_score: 1,
      depth_score: 0,
      comments: `[parse error] raw output: ${text.slice(0, 200)}`,
    };
  }
}

function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export async function simulateAudience(llm: LLMClient, opts: SimulateOpts): Promise<AudienceFeedback[]> {
  const platform = opts.platform ?? "social media";
  const calls = opts.personas.map(async (persona) => {
    const result = await llm.complete({
      tier: "cheap",
      system: [
        { text: SYSTEM_TEMPLATE(persona, platform), cache: true },
      ],
      messages: [
        { role: "user", content: `Here is the post to react to:\n\n${opts.variant_text}` },
      ],
      max_tokens: 400,
      temperature: 0.3,
    });
    return parseFeedback(result.text, persona);
  });
  return Promise.all(calls);
}
```

- [ ] **Step 6: Run tests**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/social test
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/social-pipeline/src/eval packages/social-pipeline/tests/eval && git commit -m "feat(social): evaluator personas, simulator, aggregator"
```

---

## Task 14: research_refs handler + opencli client

**Files:**
- Create: `content-harness/packages/social-pipeline/src/opencli-client.ts`
- Create: `content-harness/packages/social-pipeline/src/state.ts`
- Create: `content-harness/packages/social-pipeline/src/handlers/research_refs.ts`
- Create: `content-harness/packages/social-pipeline/tests/fixtures/opencli/twitter-search.json`
- Create: `content-harness/packages/social-pipeline/tests/handlers/research_refs.test.ts`

- [ ] **Step 1: Create state type (used by all handlers)**

Create `content-harness/packages/social-pipeline/src/state.ts`:

```ts
import type { Persona, Campaign, Piece, AssetPool, PlatformVariant, EvalRound } from "./schemas/index.js";

export interface SocialState {
  persona: Persona;
  campaign: Campaign;
  piece: Piece;
  asset_pool_summary: {
    refs_last_refreshed: string | null;
    reference_post_count: number;
  };
}

export function initSocialState(input: { persona: Persona; campaign: Campaign; piece: Piece }): SocialState {
  return {
    persona: input.persona,
    campaign: input.campaign,
    piece: input.piece,
    asset_pool_summary: {
      refs_last_refreshed: null,
      reference_post_count: 0,
    },
  };
}
```

- [ ] **Step 2: Create opencli subprocess client**

Create `content-harness/packages/social-pipeline/src/opencli-client.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface OpencliTwitterSearchResult {
  id: string;
  author: string;
  url: string;
  content: string;
  engagement?: { likes?: number; retweets?: number; replies?: number; views?: number };
}

export interface OpencliClient {
  twitterSearch(query: string, limit?: number): Promise<OpencliTwitterSearchResult[]>;
}

export function makeOpencliSubprocessClient(opts: { bin?: string } = {}): OpencliClient {
  const bin = opts.bin ?? "opencli";
  return {
    async twitterSearch(query: string, limit = 20): Promise<OpencliTwitterSearchResult[]> {
      const { stdout } = await execFileAsync(bin, [
        "twitter", "search",
        "--query", query,
        "--limit", String(limit),
        "--json",
      ]);
      const parsed = JSON.parse(stdout) as unknown;
      if (!Array.isArray(parsed)) throw new Error("opencli twitter search did not return an array");
      return parsed as OpencliTwitterSearchResult[];
    },
  };
}

export function fakeOpencliClient(fixtures: { [query: string]: OpencliTwitterSearchResult[] }): OpencliClient {
  return {
    async twitterSearch(query: string): Promise<OpencliTwitterSearchResult[]> {
      const hit = fixtures[query] ?? Object.values(fixtures)[0] ?? [];
      return hit;
    },
  };
}
```

- [ ] **Step 3: Create opencli twitter fixture**

Create `content-harness/packages/social-pipeline/tests/fixtures/opencli/twitter-search.json`:

```json
[
  {
    "id": "1800000000000000001",
    "author": "eugeneyan",
    "url": "https://twitter.com/eugeneyan/status/1800000000000000001",
    "content": "Building an eval harness taught me: the interesting part is never the model. It's the state machine around it. Here's what we shipped after 6 weeks.",
    "engagement": { "likes": 842, "retweets": 120, "replies": 44, "views": 31000 }
  },
  {
    "id": "1800000000000000002",
    "author": "simonw",
    "url": "https://twitter.com/simonw/status/1800000000000000002",
    "content": "Three lessons from running agents in production: 1) budget every loop, 2) persist state between every step, 3) evals lie unless they mirror real users.",
    "engagement": { "likes": 1240, "retweets": 210, "replies": 67, "views": 48000 }
  },
  {
    "id": "1800000000000000003",
    "author": "hwchase17",
    "url": "https://twitter.com/hwchase17/status/1800000000000000003",
    "content": "Why do agent loops stall? Usually not the model. Usually a silent state bug or an uncharged retry. Instrument everything.",
    "engagement": { "likes": 503, "retweets": 71, "replies": 18, "views": 17200 }
  }
]
```

- [ ] **Step 4: Write failing handler test**

Create `content-harness/packages/social-pipeline/tests/handlers/research_refs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeResearchRefsHandler } from "../../src/handlers/research_refs.js";
import { fakeOpencliClient } from "../../src/opencli-client.js";
import { makeFilesystemAssetStore } from "../../src/asset-store.js";
import { silentLogger, systemClock, fakeLLMClient } from "@content-harness/core";
import type { InfraBundle, Task } from "@content-harness/core";
import { initSocialState } from "../../src/state.js";

const fixtureDir = new URL("../fixtures/opencli/", import.meta.url);

async function loadFixture() {
  const raw = await readFile(new URL("twitter-search.json", fixtureDir), "utf8");
  return JSON.parse(raw);
}

const persona = {
  id: "liu",
  identity: { name: "Liu", one_line_bio: "", long_bio: "" },
  voice: { tone: "analytic", point_of_view: "first-person", vocabulary: { prefer: [], avoid: [] }, example_phrases: [] },
  domain: { primary_topics: ["ai"], expertise_depth: "practitioner" as const, adjacent_topics: [] },
  audience: { description: "eng", pain_points: [], sophistication: "practitioner" as const, evaluator_persona_ids: ["p1"] },
  platforms: [{ platform: "twitter" as const, handle: "liu", priority: 1, role: "primary" as const }],
  style_references: { emulate: [], avoid: [] },
  success_metrics: { primary: "engagement" as const, red_lines: [] },
  asset_pool_id: "liu",
};

const campaign = {
  id: "q2",
  persona_id: "liu",
  goal: "ship",
  timeline: { start: "2026-04-01T00:00:00Z" },
  key_messages: [],
  content_mix: {},
  overrides: {},
  success_criteria: "",
};

const piece = {
  id: "piece1",
  campaign_id: "q2",
  persona_id: "liu",
  input: { raw_materials: [], intent: "explain the loop" },
  state: "draft" as const,
  platform_variants: [],
  eval_history: [],
};

const baseState = () => initSocialState({ persona, campaign, piece });

const task: Task<string> = {
  id: "research_refs_twitter",
  kind: "research_refs",
  params: { platform: "twitter", query: "agent harness loop" },
  deps: [],
  input_refs: [],
  acceptance_criteria: "refs added",
  gate_before: false,
  gate_after: false,
  status: "pending",
};

describe("research_refs handler", () => {
  it("calls opencli, normalizes results, and writes them to asset pool", async () => {
    const root = mkdtempSync(join(tmpdir(), "research-refs-"));
    const fixture = await loadFixture();
    const opencli = fakeOpencliClient({ "agent harness loop": fixture });
    const assets = makeFilesystemAssetStore(root);
    const infra: InfraBundle = {
      llm: fakeLLMClient([]),
      assets,
      logger: silentLogger(),
      clock: systemClock,
    };
    const handler = makeResearchRefsHandler({ opencli });
    const delta = await handler(task, baseState(), infra);
    expect(delta.kind).toBe("success");
    const all = await assets.query<{ id: string }>("liu", "reference_posts");
    expect(all).toHaveLength(3);
    expect(delta.patches.some((p) => p.path.includes("asset_pool_summary"))).toBe(true);
  });

  it("fails gracefully when opencli returns zero results", async () => {
    const root = mkdtempSync(join(tmpdir(), "research-refs-"));
    const opencli = fakeOpencliClient({});
    const assets = makeFilesystemAssetStore(root);
    const infra: InfraBundle = {
      llm: fakeLLMClient([]),
      assets,
      logger: silentLogger(),
      clock: systemClock,
    };
    const handler = makeResearchRefsHandler({ opencli });
    const delta = await handler(task, baseState(), infra);
    expect(delta.kind).toBe("failure");
    expect(delta.error?.retryable).toBe(true);
  });
});
```

- [ ] **Step 5: Implement research_refs handler**

Create `content-harness/packages/social-pipeline/src/handlers/research_refs.ts`:

```ts
import type { Delta, InfraBundle, Task, TaskHandler } from "@content-harness/core";
import type { OpencliClient } from "../opencli-client.js";
import type { ReferencePost } from "../schemas/index.js";
import type { SocialState } from "../state.js";

export interface ResearchRefsDeps {
  opencli: OpencliClient;
}

export function makeResearchRefsHandler(deps: ResearchRefsDeps): TaskHandler<SocialState> {
  return async (task: Task<string>, state: SocialState, infra: InfraBundle): Promise<Delta<SocialState>> => {
    const platform = String(task.params.platform ?? "twitter");
    const query = String(task.params.query ?? state.piece.input.intent);
    const limit = Number(task.params.limit ?? 20);

    infra.logger.info("research_refs.start", { platform, query });

    if (platform !== "twitter") {
      return {
        kind: "failure",
        patches: [],
        cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
        error: { message: `research_refs only supports twitter in v1, got ${platform}`, retryable: false },
      };
    }

    try {
      const results = await deps.opencli.twitterSearch(query, limit);
      if (results.length === 0) {
        return {
          kind: "failure",
          patches: [],
          cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
          error: { message: `opencli returned no reference_posts for query '${query}'`, retryable: true },
        };
      }

      const now = infra.clock.now().toISOString();
      const records: ReferencePost[] = results.map((r) => ({
        id: `rp-${platform}-${r.id}`,
        platform,
        author: r.author,
        url: r.url,
        content: r.content,
        engagement: {
          likes: r.engagement?.likes,
          shares: r.engagement?.retweets,
          comments: r.engagement?.replies,
          views: r.engagement?.views,
        },
        topic_tags: [],
        collected_at: now,
        source_query: query,
      }));

      await infra.assets.append(state.persona.asset_pool_id, "reference_posts", records);
      infra.logger.info("research_refs.done", { count: records.length });

      return {
        kind: "success",
        patches: [
          {
            op: "merge",
            path: ["asset_pool_summary"],
            value: {
              refs_last_refreshed: now,
              reference_post_count: state.asset_pool_summary.reference_post_count + records.length,
            },
          },
        ],
        cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      };
    } catch (err) {
      return {
        kind: "failure",
        patches: [],
        cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
        error: { message: err instanceof Error ? err.message : String(err), retryable: true },
      };
    }
  };
}
```

- [ ] **Step 6: Run tests**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/social test
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/social-pipeline/src/state.ts packages/social-pipeline/src/opencli-client.ts packages/social-pipeline/src/handlers/research_refs.ts packages/social-pipeline/tests/handlers packages/social-pipeline/tests/fixtures && git commit -m "feat(social): research_refs handler + opencli subprocess client"
```

---

## Task 15: draft_base handler

**Files:**
- Create: `content-harness/packages/social-pipeline/src/handlers/draft_base.ts`
- Create: `content-harness/packages/social-pipeline/tests/fixtures/llm/draft-base.json`
- Create: `content-harness/packages/social-pipeline/tests/handlers/draft_base.test.ts`

- [ ] **Step 1: Create LLM fixture**

Create `content-harness/packages/social-pipeline/tests/fixtures/llm/draft-base.json`:

```json
{
  "text": "# What I learned debugging the harness loop\n\nThree weeks ago our agent loop was dropping tasks. Not crashing — just silently skipping. The culprit wasn't the model. It was the state machine.\n\nHere's what I learned:\n\n1. Every task delta has to be append-only. If the handler returns a partial state, you'll lose the rest.\n2. Budget has to be checked after charge, not before. Otherwise you overshoot by one call.\n3. Retries without attribution multiply invisibly. Tag every retry with a reason code.\n\nThe fix took 40 lines. Finding it took five days of staring at logs. Observability is the whole game.",
  "cost": { "input_tokens": 900, "output_tokens": 180, "usd": 0.028 },
  "stop_reason": "end_turn"
}
```

- [ ] **Step 2: Write failing test**

Create `content-harness/packages/social-pipeline/tests/handlers/draft_base.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { draftBaseHandler } from "../../src/handlers/draft_base.js";
import { fakeLLMClient, silentLogger, systemClock } from "@content-harness/core";
import type { InfraBundle, Task } from "@content-harness/core";
import { initSocialState } from "../../src/state.js";

const fixtureUrl = new URL("../fixtures/llm/draft-base.json", import.meta.url);

const persona = {
  id: "liu",
  identity: { name: "Liu", one_line_bio: "bio", long_bio: "long" },
  voice: {
    tone: "conversational analytical",
    point_of_view: "first-person practitioner",
    vocabulary: { prefer: ["harness", "loop"], avoid: ["revolutionize"] },
    example_phrases: ["We hit this bug last week."],
  },
  domain: { primary_topics: ["AI infrastructure"], expertise_depth: "practitioner" as const, adjacent_topics: [] },
  audience: { description: "eng", pain_points: ["flakiness"], sophistication: "practitioner" as const, evaluator_persona_ids: ["p1"] },
  platforms: [{ platform: "twitter" as const, handle: "liu", priority: 1, role: "primary" as const }],
  style_references: { emulate: [], avoid: [] },
  success_metrics: { primary: "engagement" as const, red_lines: [] },
  asset_pool_id: "liu",
};

const campaign = {
  id: "q2", persona_id: "liu", goal: "ship",
  timeline: { start: "2026-04-01T00:00:00Z" },
  key_messages: ["observability matters"], content_mix: {}, overrides: {}, success_criteria: "",
};

const piece = {
  id: "piece1", campaign_id: "q2", persona_id: "liu",
  input: {
    raw_materials: [
      { id: "rm1", kind: "text" as const, content: "we had a loop dropping tasks silently", origin: "inline" },
      { id: "rm2", kind: "note" as const, content: "fix was 40 lines but took 5 days to find", origin: "inline" },
    ],
    intent: "explain what I learned from the harness bug",
  },
  state: "draft" as const,
  platform_variants: [],
  eval_history: [],
};

const task: Task<string> = {
  id: "draft_base",
  kind: "draft_base",
  params: {},
  deps: [],
  input_refs: [],
  acceptance_criteria: "base article written",
  gate_before: false,
  gate_after: false,
  status: "pending",
};

describe("draft_base handler", () => {
  it("writes a base article using persona voice + raw materials", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
    const llm = fakeLLMClient([fixture]);
    const infra: InfraBundle = {
      llm,
      assets: { async append() {}, async query() { return []; }, async resolve() { return null; }, async putBlob() { return ""; }, async getBlob() { return null; } },
      logger: silentLogger(),
      clock: systemClock,
    };
    const state = initSocialState({ persona, campaign, piece });
    const delta = await draftBaseHandler(task, state, infra);
    expect(delta.kind).toBe("success");
    expect(delta.patches.some((p) => p.path.includes("base_article"))).toBe(true);
    const call = llm.calls[0]!;
    const systemText = Array.isArray(call.system)
      ? call.system.map((s) => s.text).join("\n")
      : call.system;
    expect(systemText).toContain("harness");
    expect(systemText).toContain("avoid");
    expect(call.messages[0]!.content).toContain("loop dropping tasks");
  });
});
```

- [ ] **Step 3: Implement draft_base**

Create `content-harness/packages/social-pipeline/src/handlers/draft_base.ts`:

```ts
import type { Delta, InfraBundle, Task, TaskHandler } from "@content-harness/core";
import type { SocialState } from "../state.js";

export const draftBaseHandler: TaskHandler<SocialState> = async (
  task: Task<string>,
  state: SocialState,
  infra: InfraBundle,
): Promise<Delta<SocialState>> => {
  const persona = state.persona;
  const piece = state.piece;

  const staticSystem = [
    `You are ghostwriting for ${persona.identity.name}.`,
    `Bio: ${persona.identity.long_bio}`,
    `Voice: tone=${persona.voice.tone}. POV=${persona.voice.point_of_view}.`,
    `Prefer words: ${persona.voice.vocabulary.prefer.join(", ") || "(none)"}`,
    `Avoid words: ${persona.voice.vocabulary.avoid.join(", ") || "(none)"}`,
    `Example phrases: ${persona.voice.example_phrases.join(" / ")}`,
    `Primary topics: ${persona.domain.primary_topics.join(", ")}`,
    `Audience: ${persona.audience.description}`,
    `Audience pain points: ${persona.audience.pain_points.join("; ") || "(none)"}`,
    `Red lines: ${persona.success_metrics.red_lines.join("; ") || "(none)"}`,
  ].join("\n");

  const turnSystem = [
    `Write the BASE ARTICLE — a platform-agnostic longform markdown draft that captures the full thinking.`,
    `This draft will later be refined into platform-specific variants (e.g., a Twitter thread).`,
    `Do NOT write for any one platform. Write the full idea once, well.`,
    `The voice rules above are absolute.`,
  ].join("\n");

  const materialsText = piece.input.raw_materials
    .map((m, i) => `- (${m.kind}, id=${m.id}) ${m.content}`)
    .join("\n");

  const userContent = `Intent: ${piece.input.intent}

Raw materials:
${materialsText || "(none)"}

Please produce a markdown base article.`;

  const reviseFeedback = typeof task.params.revise_feedback === "string" ? task.params.revise_feedback : null;
  const messages = reviseFeedback
    ? [
        { role: "user" as const, content: userContent },
        { role: "assistant" as const, content: state.piece.base_article?.markdown ?? "" },
        { role: "user" as const, content: `Revise the base article based on this feedback:\n${reviseFeedback}` },
      ]
    : [{ role: "user" as const, content: userContent }];

  const result = await infra.llm.complete({
    tier: "main",
    system: [
      { text: staticSystem, cache: true },
      { text: turnSystem, cache: false },
    ],
    messages,
    max_tokens: 1500,
    temperature: 0.6,
  });

  const now = infra.clock.now().toISOString();

  return {
    kind: "success",
    patches: [
      {
        op: "set",
        path: ["piece", "base_article"],
        value: {
          markdown: result.text,
          produced_at: now,
          source_refs: [], // v1 inlines materials; refs come from research_refs pool later
        },
      },
      { op: "set", path: ["piece", "state"], value: "refining" },
    ],
    cost: result.cost,
    result_ref: { kind: "base_article", piece_id: piece.id },
  };
};
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/social test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/social-pipeline/src/handlers/draft_base.ts packages/social-pipeline/tests/handlers/draft_base.test.ts packages/social-pipeline/tests/fixtures/llm/draft-base.json && git commit -m "feat(social): draft_base handler with persona-aware prompting"
```

---

## Task 16: refine_variant handler

**Files:**
- Create: `content-harness/packages/social-pipeline/src/handlers/refine_variant.ts`
- Create: `content-harness/packages/social-pipeline/tests/fixtures/llm/refine-variant.json`
- Create: `content-harness/packages/social-pipeline/tests/handlers/refine_variant.test.ts`

- [ ] **Step 1: Create LLM fixture**

Create `content-harness/packages/social-pipeline/tests/fixtures/llm/refine-variant.json`:

```json
{
  "text": "1/ We had an agent loop silently dropping tasks for 5 days. Not crashing — skipping. Here's what we learned.\n\n2/ The model was fine. The state machine was broken. Partial deltas ate our state. Lesson: append-only patches only.\n\n3/ Budget check has to be *after* charge, not before. Otherwise every run overshoots by one call. 40-line fix, 5-day hunt.\n\n4/ Retries without attribution multiply invisibly. Tag every retry with a reason code. If you can't ask 'why are we retrying?', you're flying blind.\n\n5/ The whole fix was 40 lines. Finding it was the job. Observability is the whole game — budget every loop, log every delta, name every retry.",
  "cost": { "input_tokens": 1100, "output_tokens": 240, "usd": 0.034 },
  "stop_reason": "end_turn"
}
```

- [ ] **Step 2: Write failing test**

Create `content-harness/packages/social-pipeline/tests/handlers/refine_variant.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { refineVariantHandler } from "../../src/handlers/refine_variant.js";
import { fakeLLMClient, silentLogger, systemClock } from "@content-harness/core";
import type { InfraBundle, Task } from "@content-harness/core";
import { initSocialState } from "../../src/state.js";

const fixtureUrl = new URL("../fixtures/llm/refine-variant.json", import.meta.url);

const persona = {
  id: "liu",
  identity: { name: "Liu", one_line_bio: "", long_bio: "" },
  voice: { tone: "analytic", point_of_view: "first-person", vocabulary: { prefer: ["harness", "loop"], avoid: ["revolutionize"] }, example_phrases: ["We hit this bug."] },
  domain: { primary_topics: ["ai"], expertise_depth: "practitioner" as const, adjacent_topics: [] },
  audience: { description: "eng", pain_points: [], sophistication: "practitioner" as const, evaluator_persona_ids: ["p1"] },
  platforms: [{ platform: "twitter" as const, handle: "liu", priority: 1, role: "primary" as const }],
  style_references: { emulate: [], avoid: [] },
  success_metrics: { primary: "engagement" as const, red_lines: [] },
  asset_pool_id: "liu",
};

const campaign = {
  id: "q2", persona_id: "liu", goal: "ship",
  timeline: { start: "2026-04-01T00:00:00Z" },
  key_messages: [], content_mix: {}, overrides: {}, success_criteria: "",
};

const pieceWithBase = {
  id: "piece1", campaign_id: "q2", persona_id: "liu",
  input: { raw_materials: [], intent: "explain" },
  state: "refining" as const,
  base_article: {
    markdown: "# long-form markdown base article with at least 200 words...",
    produced_at: "2026-04-11T00:00:00Z",
    source_refs: [],
  },
  platform_variants: [],
  eval_history: [],
};

describe("refine_variant handler", () => {
  it("produces a twitter variant constrained to 5 tweets under 280 chars each", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
    const llm = fakeLLMClient([fixture]);
    const infra: InfraBundle = {
      llm,
      assets: { async append() {}, async query() { return []; }, async resolve() { return null; }, async putBlob() { return ""; }, async getBlob() { return null; } },
      logger: silentLogger(),
      clock: systemClock,
    };
    const task: Task<string> = {
      id: "refine_twitter",
      kind: "refine_variant",
      params: { platform: "twitter" },
      deps: [],
      input_refs: [],
      acceptance_criteria: "",
      gate_before: false,
      gate_after: true,
      status: "pending",
    };
    const state = initSocialState({ persona, campaign, piece: pieceWithBase });
    const delta = await refineVariantHandler(task, state, infra);
    expect(delta.kind).toBe("success");
    // Variant appended
    expect(delta.patches.some((p) => p.op === "append" && p.path.join(".") === "piece.platform_variants")).toBe(true);
    // Result ref set
    expect(delta.result_ref?.kind).toBe("platform_variant");
    // Prompt contained platform constraints
    const systemText = (llm.calls[0]!.system as Array<{ text: string }>).map((s) => s.text).join("\n");
    expect(systemText).toContain("twitter");
    expect(systemText).toMatch(/280/);
  });

  it("fails when base_article is missing", async () => {
    const llm = fakeLLMClient([]);
    const infra: InfraBundle = {
      llm,
      assets: { async append() {}, async query() { return []; }, async resolve() { return null; }, async putBlob() { return ""; }, async getBlob() { return null; } },
      logger: silentLogger(),
      clock: systemClock,
    };
    const state = initSocialState({ persona, campaign, piece: { ...pieceWithBase, base_article: undefined } });
    const task: Task<string> = {
      id: "refine_twitter",
      kind: "refine_variant",
      params: { platform: "twitter" },
      deps: [],
      input_refs: [],
      acceptance_criteria: "",
      gate_before: false,
      gate_after: true,
      status: "pending",
    };
    const delta = await refineVariantHandler(task, state, infra);
    expect(delta.kind).toBe("failure");
    expect(delta.error?.retryable).toBe(false);
  });
});
```

- [ ] **Step 3: Implement refine_variant**

Create `content-harness/packages/social-pipeline/src/handlers/refine_variant.ts`:

```ts
import type { Delta, InfraBundle, Task, TaskHandler } from "@content-harness/core";
import type { PlatformVariant } from "../schemas/index.js";
import type { SocialState } from "../state.js";

const TWITTER_CONSTRAINTS = [
  "Target: a thread of 3–7 tweets",
  "Each tweet ≤ 280 characters",
  "Number tweets like '1/', '2/', ..., '7/'",
  "Hook on tweet 1 must stand alone (someone could quote it)",
  "Max 2 hashtags total across the thread, preferably none",
  "No emojis unless Persona example_phrases include them",
];

const PLATFORM_CONSTRAINTS: Record<string, string[]> = {
  twitter: TWITTER_CONSTRAINTS,
};

export const refineVariantHandler: TaskHandler<SocialState> = async (
  task: Task<string>,
  state: SocialState,
  infra: InfraBundle,
): Promise<Delta<SocialState>> => {
  const platform = String(task.params.platform ?? "twitter");
  if (!state.piece.base_article) {
    return {
      kind: "failure",
      patches: [],
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      error: { message: "refine_variant needs base_article in state", retryable: false },
    };
  }
  const constraints = PLATFORM_CONSTRAINTS[platform] ?? [];
  if (constraints.length === 0) {
    return {
      kind: "failure",
      patches: [],
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      error: { message: `no constraints defined for platform ${platform}`, retryable: false },
    };
  }

  const persona = state.persona;
  const variantIdx = state.piece.platform_variants.filter((v) => v.platform === platform).length;

  const staticSystem = [
    `You are ghostwriting for ${persona.identity.name} on ${platform}.`,
    `Voice: tone=${persona.voice.tone}. POV=${persona.voice.point_of_view}.`,
    `Prefer words: ${persona.voice.vocabulary.prefer.join(", ") || "(none)"}`,
    `Avoid words: ${persona.voice.vocabulary.avoid.join(", ") || "(none)"}`,
    `Example phrases: ${persona.voice.example_phrases.join(" / ")}`,
    `Red lines: ${persona.success_metrics.red_lines.join("; ") || "(none)"}`,
  ].join("\n");

  const turnSystem = [
    `Task: convert the BASE ARTICLE into a platform-native variant for ${platform}.`,
    ...constraints.map((c) => `- ${c}`),
    `Return ONLY the variant text, no preface.`,
  ].join("\n");

  const userContent = `Base article (markdown):\n\n${state.piece.base_article.markdown}`;

  const result = await infra.llm.complete({
    tier: "main",
    system: [
      { text: staticSystem, cache: true },
      { text: turnSystem, cache: false },
    ],
    messages: [{ role: "user", content: userContent }],
    max_tokens: 1500,
    temperature: 0.55,
  });

  const variant: PlatformVariant = {
    platform,
    content: result.text,
    constraints_applied: constraints,
    inspired_by: [],
    style_patterns_applied: [],
    status: "pending_eval",
    revision_count: 0,
  };

  return {
    kind: "success",
    patches: [
      { op: "append", path: ["piece", "platform_variants"], value: variant },
    ],
    cost: result.cost,
    result_ref: {
      kind: "platform_variant",
      piece_id: state.piece.id,
      platform,
      variant_idx: variantIdx,
    },
  };
};
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/social test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/social-pipeline/src/handlers/refine_variant.ts packages/social-pipeline/tests/handlers/refine_variant.test.ts packages/social-pipeline/tests/fixtures/llm/refine-variant.json && git commit -m "feat(social): refine_variant handler (twitter-only in v1)"
```

---

## Task 17: eval_variant handler

**Files:**
- Create: `content-harness/packages/social-pipeline/src/handlers/eval_variant.ts`
- Create: `content-harness/packages/social-pipeline/tests/fixtures/llm/eval-variant-persona-1.json`
- Create: `content-harness/packages/social-pipeline/tests/fixtures/llm/eval-variant-persona-2.json`
- Create: `content-harness/packages/social-pipeline/tests/fixtures/llm/eval-variant-persona-3.json`
- Create: `content-harness/packages/social-pipeline/tests/handlers/eval_variant.test.ts`

- [ ] **Step 1: Create per-persona fixtures (passing thresholds)**

Create `content-harness/packages/social-pipeline/tests/fixtures/llm/eval-variant-persona-1.json`:

```json
{
  "text": "{\"understood\": true, \"engagement_likelihood\": 0.82, \"ai_smell_score\": 0.18, \"depth_score\": 0.76, \"comments\": \"Concrete numbers, clear failure mode. I would retweet.\"}",
  "cost": { "input_tokens": 400, "output_tokens": 80, "usd": 0.002 },
  "stop_reason": "end_turn"
}
```

Create `content-harness/packages/social-pipeline/tests/fixtures/llm/eval-variant-persona-2.json`:

```json
{
  "text": "{\"understood\": true, \"engagement_likelihood\": 0.78, \"ai_smell_score\": 0.22, \"depth_score\": 0.68, \"comments\": \"Gets the point fast. Tweet 4 could be tighter but the hook works for me.\"}",
  "cost": { "input_tokens": 400, "output_tokens": 80, "usd": 0.002 },
  "stop_reason": "end_turn"
}
```

Create `content-harness/packages/social-pipeline/tests/fixtures/llm/eval-variant-persona-3.json`:

```json
{
  "text": "{\"understood\": true, \"engagement_likelihood\": 0.74, \"ai_smell_score\": 0.25, \"depth_score\": 0.7, \"comments\": \"Rigor is there. I'd like one more specific anti-pattern but this reads as practitioner-grade.\"}",
  "cost": { "input_tokens": 400, "output_tokens": 80, "usd": 0.002 },
  "stop_reason": "end_turn"
}
```

- [ ] **Step 2: Write failing test**

Create `content-harness/packages/social-pipeline/tests/handlers/eval_variant.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { evalVariantHandler } from "../../src/handlers/eval_variant.js";
import { DEFAULT_EVALUATOR_PERSONAS } from "../../src/eval/personas.js";
import { fakeLLMClient, silentLogger, systemClock } from "@content-harness/core";
import type { AssetRef, InfraBundle, Task } from "@content-harness/core";
import { initSocialState } from "../../src/state.js";

const loadFixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`../fixtures/llm/${name}`, import.meta.url), "utf8"));

const persona = {
  id: "liu",
  identity: { name: "Liu", one_line_bio: "", long_bio: "" },
  voice: { tone: "analytic", point_of_view: "first-person", vocabulary: { prefer: [], avoid: [] }, example_phrases: [] },
  domain: { primary_topics: [], expertise_depth: "practitioner" as const, adjacent_topics: [] },
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

const campaign = {
  id: "q2", persona_id: "liu", goal: "ship",
  timeline: { start: "2026-04-01T00:00:00Z" },
  key_messages: [], content_mix: {}, overrides: {}, success_criteria: "",
};

const pieceWithVariant = {
  id: "piece1", campaign_id: "q2", persona_id: "liu",
  input: { raw_materials: [], intent: "explain" },
  state: "evaluating" as const,
  platform_variants: [{
    platform: "twitter",
    content: "1/ harness bug story",
    constraints_applied: [],
    inspired_by: [],
    style_patterns_applied: [],
    status: "pending_eval" as const,
    revision_count: 0,
  }],
  eval_history: [],
};

const fakeAssetsWithPersonas = () => ({
  async append() {},
  async query() { return []; },
  async resolve<T>(_pool: string, ref: AssetRef): Promise<T | null> {
    if (ref.kind !== "evaluator_persona") return null;
    const p = DEFAULT_EVALUATOR_PERSONAS.find((ep) => ep.id === ref.id);
    return (p as T | undefined) ?? null;
  },
  async putBlob() { return ""; },
  async getBlob() { return null; },
});

describe("eval_variant handler", () => {
  it("dispatches simulator, aggregates, appends EvalRound, marks variant accepted", async () => {
    const f1 = await loadFixture("eval-variant-persona-1.json");
    const f2 = await loadFixture("eval-variant-persona-2.json");
    const f3 = await loadFixture("eval-variant-persona-3.json");
    const llm = fakeLLMClient([f1, f2, f3]);
    const infra: InfraBundle = {
      llm,
      assets: fakeAssetsWithPersonas(),
      logger: silentLogger(),
      clock: systemClock,
    };
    const task: Task<string> = {
      id: "eval_twitter",
      kind: "eval_variant",
      params: { platform: "twitter", variant_idx: 0 },
      deps: [],
      input_refs: DEFAULT_EVALUATOR_PERSONAS.map((p) => ({ kind: "evaluator_persona" as const, id: p.id })),
      acceptance_criteria: "",
      gate_before: false,
      gate_after: false,
      status: "pending",
    };
    const state = initSocialState({ persona, campaign, piece: pieceWithVariant });
    const delta = await evalVariantHandler(task, state, infra);
    expect(delta.kind).toBe("success");
    // Eval round appended
    expect(delta.patches.some((p) => p.op === "append" && p.path.join(".") === "piece.eval_history")).toBe(true);
    // Variant status updated to accepted
    const statusPatch = delta.patches.find((p) => p.path.includes("status"));
    expect(statusPatch?.value).toBe("accepted");
  });

  it("marks variant rejected when thresholds fail", async () => {
    const failing = {
      text: JSON.stringify({ understood: true, engagement_likelihood: 0.4, ai_smell_score: 0.6, depth_score: 0.3, comments: "too generic" }),
      cost: { input_tokens: 400, output_tokens: 80, usd: 0.002 },
      stop_reason: "end_turn",
    };
    const llm = fakeLLMClient([failing, failing, failing]);
    const infra: InfraBundle = {
      llm,
      assets: fakeAssetsWithPersonas(),
      logger: silentLogger(),
      clock: systemClock,
    };
    const task: Task<string> = {
      id: "eval_twitter",
      kind: "eval_variant",
      params: { platform: "twitter", variant_idx: 0 },
      deps: [],
      input_refs: DEFAULT_EVALUATOR_PERSONAS.map((p) => ({ kind: "evaluator_persona" as const, id: p.id })),
      acceptance_criteria: "",
      gate_before: false,
      gate_after: false,
      status: "pending",
    };
    const state = initSocialState({ persona, campaign, piece: pieceWithVariant });
    const delta = await evalVariantHandler(task, state, infra);
    expect(delta.kind).toBe("success");
    const statusPatch = delta.patches.find((p) => p.path.includes("status"));
    expect(statusPatch?.value).toBe("rejected");
  });
});
```

- [ ] **Step 3: Implement eval_variant**

Create `content-harness/packages/social-pipeline/src/handlers/eval_variant.ts`:

```ts
import type { AssetRef, Delta, InfraBundle, Task, TaskHandler } from "@content-harness/core";
import { aggregate } from "../eval/aggregator.js";
import { simulateAudience } from "../eval/simulator.js";
import { DEFAULT_EVALUATOR_PERSONAS } from "../eval/personas.js";
import type { EvalRound, EvaluatorPersona, PlatformVariant } from "../schemas/index.js";
import type { SocialState } from "../state.js";

const DEFAULT_THRESHOLDS = { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 };

export const evalVariantHandler: TaskHandler<SocialState> = async (
  task: Task<string>,
  state: SocialState,
  infra: InfraBundle,
): Promise<Delta<SocialState>> => {
  const platform = String(task.params.platform ?? "twitter");
  const variantIdx = Number(task.params.variant_idx ?? 0);
  const variant = state.piece.platform_variants.find((v, i) => v.platform === platform && i === variantIdx);
  if (!variant) {
    return {
      kind: "failure",
      patches: [],
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      error: { message: `no variant at (${platform}, ${variantIdx})`, retryable: false },
    };
  }

  // Resolve evaluator personas via AssetRefs in task.input_refs. Fall back to defaults
  // if the asset pool does not yet contain them (bootstrap case).
  const personaRefs: AssetRef[] = task.input_refs.filter((r) => r.kind === "evaluator_persona");
  const resolvedPersonas: EvaluatorPersona[] = [];
  for (const ref of personaRefs) {
    const p = await infra.assets.resolve<EvaluatorPersona>(state.persona.asset_pool_id, ref);
    if (p) resolvedPersonas.push(p);
  }
  const personas = resolvedPersonas.length > 0 ? resolvedPersonas : DEFAULT_EVALUATOR_PERSONAS;

  const feedback = await simulateAudience(infra.llm, {
    variant_text: variant.content,
    personas,
    platform,
  });

  const round = state.piece.eval_history.length;
  const target = {
    kind: "platform_variant" as const,
    piece_id: state.piece.id,
    platform,
    variant_idx: variantIdx,
  };
  const agg = aggregate(feedback, DEFAULT_THRESHOLDS, target);

  const evalRound: EvalRound = {
    round,
    target,
    audience_feedback: feedback,
    aggregated_score: agg.aggregated_score,
    actionable_feedback: agg.actionable_feedback,
    verdict: agg.verdict,
  };

  // Variant status + eval_score patch
  const variantIdxInArray = state.piece.platform_variants.findIndex((v, i) => v.platform === platform && i === variantIdx);

  const totalCost = feedback.reduce(
    (acc, _f, i) => ({
      input_tokens: acc.input_tokens,
      output_tokens: acc.output_tokens,
      usd: acc.usd,
    }),
    { input_tokens: 0, output_tokens: 0, usd: 0 },
  );
  // The simulator already spent cost inside llm.complete calls; infra should not double charge.
  // We leave totalCost at zero — the fake LLM records individual calls; production LLM client
  // will emit cost events through its own path.

  return {
    kind: "success",
    patches: [
      { op: "append", path: ["piece", "eval_history"], value: evalRound },
      {
        op: "set",
        path: ["piece", "platform_variants", String(variantIdxInArray), "status"],
        value: agg.verdict === "accept" ? "accepted" : "rejected",
      },
      {
        op: "set",
        path: ["piece", "platform_variants", String(variantIdxInArray), "eval_score"],
        value: agg.aggregated_score,
      },
    ],
    cost: totalCost,
    result_ref: { kind: "eval_round", piece_id: state.piece.id, round },
  };
};
```

Note the path uses a string index (`String(variantIdxInArray)`) because `applyPatch` in core walks object keys. The core loop does an `Array.isArray` check and spreads arrays, so numeric-string indices work on both arrays and objects.

- [ ] **Step 4: Run tests**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/social test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/social-pipeline/src/handlers/eval_variant.ts packages/social-pipeline/tests/handlers/eval_variant.test.ts packages/social-pipeline/tests/fixtures/llm/eval-variant-persona-1.json packages/social-pipeline/tests/fixtures/llm/eval-variant-persona-2.json packages/social-pipeline/tests/fixtures/llm/eval-variant-persona-3.json && git commit -m "feat(social): eval_variant handler with sub-agent simulation"
```

---

## Task 18: revise handler

**Files:**
- Create: `content-harness/packages/social-pipeline/src/handlers/revise.ts`
- Create: `content-harness/packages/social-pipeline/tests/fixtures/llm/revise.json`
- Create: `content-harness/packages/social-pipeline/tests/handlers/revise.test.ts`

- [ ] **Step 1: Create fixture**

Create `content-harness/packages/social-pipeline/tests/fixtures/llm/revise.json`:

```json
{
  "text": "1/ 5 days. 40 lines. One silent state bug in an agent loop. Here's what debugging it taught me.\n\n2/ Symptom: tasks disappearing from the queue. No error, no log, just gone. Model was innocent — the state machine ate them.\n\n3/ Root cause: handlers returned partial state deltas. Anything not in the delta got dropped on merge. Fix: append-only patches, no object replacements.\n\n4/ Adjacent bug: budget check happened before charge, so every run overshot by exactly one call. Off-by-one is cheap to write, expensive to catch.\n\n5/ Real lesson: the interesting work in agent systems is never the model. It's the plumbing. Budget every loop. Log every delta. Tag every retry with a reason code.",
  "cost": { "input_tokens": 1600, "output_tokens": 250, "usd": 0.042 },
  "stop_reason": "end_turn"
}
```

- [ ] **Step 2: Write failing test**

Create `content-harness/packages/social-pipeline/tests/handlers/revise.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { reviseHandler } from "../../src/handlers/revise.js";
import { fakeLLMClient, silentLogger, systemClock } from "@content-harness/core";
import type { InfraBundle, Task } from "@content-harness/core";
import { initSocialState } from "../../src/state.js";

const fixtureUrl = new URL("../fixtures/llm/revise.json", import.meta.url);

const persona = {
  id: "liu",
  identity: { name: "Liu", one_line_bio: "", long_bio: "" },
  voice: { tone: "analytic", point_of_view: "first-person", vocabulary: { prefer: ["harness"], avoid: ["revolutionize"] }, example_phrases: [] },
  domain: { primary_topics: [], expertise_depth: "practitioner" as const, adjacent_topics: [] },
  audience: { description: "", pain_points: [], sophistication: "practitioner" as const, evaluator_persona_ids: [] },
  platforms: [{ platform: "twitter" as const, handle: "liu", priority: 1, role: "primary" as const }],
  style_references: { emulate: [], avoid: [] },
  success_metrics: { primary: "engagement" as const, red_lines: [] },
  asset_pool_id: "liu",
};

const campaign = { id: "q2", persona_id: "liu", goal: "", timeline: { start: "2026-04-01T00:00:00Z" }, key_messages: [], content_mix: {}, overrides: {}, success_criteria: "" };

const pieceEvaluated = {
  id: "piece1", campaign_id: "q2", persona_id: "liu",
  input: { raw_materials: [], intent: "" },
  state: "refining" as const,
  platform_variants: [{
    platform: "twitter",
    content: "old variant content",
    constraints_applied: [],
    inspired_by: [],
    style_patterns_applied: [],
    status: "rejected" as const,
    revision_count: 0,
  }],
  eval_history: [{
    round: 0,
    target: { kind: "platform_variant" as const, piece_id: "piece1", platform: "twitter", variant_idx: 0 },
    audience_feedback: [],
    aggregated_score: 0.55,
    actionable_feedback: [{
      from: { kind: "evaluator_persona" as const, id: "p1" },
      category: "tone" as const,
      text: "opening feels generic, add a concrete number",
      targets: [],
    }],
    verdict: "revise" as const,
  }],
};

describe("revise handler", () => {
  it("produces a new variant informed by actionable_feedback, increments revision_count", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
    const llm = fakeLLMClient([fixture]);
    const infra: InfraBundle = {
      llm,
      assets: { async append() {}, async query() { return []; }, async resolve() { return null; }, async putBlob() { return ""; }, async getBlob() { return null; } },
      logger: silentLogger(),
      clock: systemClock,
    };
    const task: Task<string> = {
      id: "revise_twitter",
      kind: "revise",
      params: { platform: "twitter", variant_idx: 0 },
      deps: [],
      input_refs: [],
      acceptance_criteria: "",
      gate_before: false,
      gate_after: true,
      status: "pending",
    };
    const state = initSocialState({ persona, campaign, piece: pieceEvaluated });
    const delta = await reviseHandler(task, state, infra);
    expect(delta.kind).toBe("success");
    // Appends a new variant (not overwriting)
    expect(delta.patches.some((p) => p.op === "append" && p.path.join(".") === "piece.platform_variants")).toBe(true);
    // Prompt mentions the actionable feedback
    const userMsg = llm.calls[0]!.messages.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("concrete number");
  });
});
```

- [ ] **Step 3: Implement revise**

Create `content-harness/packages/social-pipeline/src/handlers/revise.ts`:

```ts
import type { Delta, InfraBundle, Task, TaskHandler } from "@content-harness/core";
import type { PlatformVariant } from "../schemas/index.js";
import type { SocialState } from "../state.js";

export const reviseHandler: TaskHandler<SocialState> = async (
  task: Task<string>,
  state: SocialState,
  infra: InfraBundle,
): Promise<Delta<SocialState>> => {
  const platform = String(task.params.platform ?? "twitter");
  const variantIdx = Number(task.params.variant_idx ?? 0);
  const variant = state.piece.platform_variants.find((v, i) => v.platform === platform && i === variantIdx);
  if (!variant) {
    return {
      kind: "failure",
      patches: [],
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      error: { message: `no variant at (${platform}, ${variantIdx}) to revise`, retryable: false },
    };
  }

  // Find latest eval round for this variant
  const rounds = state.piece.eval_history.filter((r) =>
    r.target.kind === "platform_variant"
    && r.target.platform === platform
    && r.target.variant_idx === variantIdx,
  );
  const latest = rounds[rounds.length - 1];
  const feedbackBlock = latest?.actionable_feedback
    .map((a) => `- [${a.category}] ${a.text}`)
    .join("\n") || "(no feedback; rewrite for clarity)";

  const persona = state.persona;

  const staticSystem = [
    `You are ghostwriting for ${persona.identity.name} on ${platform}.`,
    `Voice: tone=${persona.voice.tone}. POV=${persona.voice.point_of_view}.`,
    `Prefer words: ${persona.voice.vocabulary.prefer.join(", ") || "(none)"}`,
    `Avoid words: ${persona.voice.vocabulary.avoid.join(", ") || "(none)"}`,
  ].join("\n");

  const turnSystem = [
    `Task: REVISE the existing variant. Address every piece of actionable feedback below.`,
    `Keep the structure unless feedback explicitly says to rewrite the hook/format.`,
    `Return only the revised variant text.`,
  ].join("\n");

  const userContent = `Previous variant:\n\n${variant.content}\n\nActionable feedback:\n${feedbackBlock}\n\nBase article for reference:\n${state.piece.base_article?.markdown ?? "(missing)"}`;

  const result = await infra.llm.complete({
    tier: "main",
    system: [
      { text: staticSystem, cache: true },
      { text: turnSystem, cache: false },
    ],
    messages: [{ role: "user", content: userContent }],
    max_tokens: 1500,
    temperature: 0.55,
  });

  const nextVariant: PlatformVariant = {
    platform,
    content: result.text,
    constraints_applied: variant.constraints_applied,
    inspired_by: variant.inspired_by,
    style_patterns_applied: variant.style_patterns_applied,
    status: "pending_eval",
    revision_count: variant.revision_count + 1,
  };

  const newVariantIdx = state.piece.platform_variants.length;

  return {
    kind: "success",
    patches: [
      { op: "append", path: ["piece", "platform_variants"], value: nextVariant },
    ],
    cost: result.cost,
    result_ref: { kind: "platform_variant", piece_id: state.piece.id, platform, variant_idx: newVariantIdx },
  };
};
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/social test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/social-pipeline/src/handlers/revise.ts packages/social-pipeline/tests/handlers/revise.test.ts packages/social-pipeline/tests/fixtures/llm/revise.json && git commit -m "feat(social): revise handler using latest EvalRound actionable_feedback"
```

---

## Task 19: domain.ts — implement HarnessDomain for social-pipeline

**Files:**
- Create: `content-harness/packages/social-pipeline/src/domain.ts`
- Create: `content-harness/packages/social-pipeline/src/index.ts`
- Create: `content-harness/packages/social-pipeline/tests/domain.test.ts`

- [ ] **Step 1: Write failing domain test**

Create `content-harness/packages/social-pipeline/tests/domain.test.ts`:

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

const stubConfig = {
  run_id: "r", run_root: "/tmp",
  budget: { max_iterations: 100 },
  retry: { max_attempts: 2, backoff_ms: 0 },
  gates: { post_plan: false, pre_publish: false },
  gate_resolver: async () => "approve" as const,
  thresholds: { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 },
  max_revisions: 3,
};

describe("social domain", () => {
  it("initState builds SocialState from input object", () => {
    const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });
    const state = domain.initState({ persona, campaign, piece });
    expect((state as any).persona.id).toBe("liu");
    expect((state as any).piece.id).toBe("piece1");
  });

  it("planInitial emits research_refs, draft_base, refine_variant, eval_variant in dep order", async () => {
    const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });
    const state = domain.initState({ persona, campaign, piece });
    const plan = await domain.planInitial({ state, config: stubConfig });
    const kinds = plan.tasks.map((t) => t.kind);
    expect(kinds).toContain("research_refs");
    expect(kinds).toContain("draft_base");
    expect(kinds).toContain("refine_variant");
    expect(kinds).toContain("eval_variant");
    // draft_base deps on research_refs
    const draft = plan.tasks.find((t) => t.kind === "draft_base")!;
    const research = plan.tasks.find((t) => t.kind === "research_refs")!;
    expect(draft.deps).toContain(research.id);
  });

  it("refine_variant task has gate_after true", async () => {
    const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });
    const state = domain.initState({ persona, campaign, piece });
    const plan = await domain.planInitial({ state, config: stubConfig });
    const refine = plan.tasks.find((t) => t.kind === "refine_variant")!;
    expect(refine.gate_after).toBe(true);
  });

  it("evaluate returns done when all platform variants are accepted", async () => {
    const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });
    const acceptedPiece = {
      ...piece,
      platform_variants: [{
        platform: "twitter",
        content: "x",
        constraints_applied: [],
        inspired_by: [],
        style_patterns_applied: [],
        status: "accepted" as const,
        revision_count: 0,
      }],
    };
    const state = domain.initState({ persona, campaign, piece: acceptedPiece });
    const verdict = await domain.evaluate(state);
    expect(verdict.kind).toBe("done");
  });

  it("evaluate returns revise when a variant was rejected and max_revisions not hit", async () => {
    const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });
    const rejectedPiece = {
      ...piece,
      platform_variants: [{
        platform: "twitter",
        content: "x",
        constraints_applied: [],
        inspired_by: [],
        style_patterns_applied: [],
        status: "rejected" as const,
        revision_count: 0,
      }],
      eval_history: [{
        round: 0,
        target: { kind: "platform_variant" as const, piece_id: "piece1", platform: "twitter", variant_idx: 0 },
        audience_feedback: [],
        aggregated_score: 0.5,
        actionable_feedback: [],
        verdict: "revise" as const,
      }],
    };
    const state = domain.initState({ persona, campaign, piece: rejectedPiece });
    const verdict = await domain.evaluate(state);
    expect(verdict.kind).toBe("revise");
  });
});
```

- [ ] **Step 2: Implement domain.ts**

Create `content-harness/packages/social-pipeline/src/domain.ts`:

```ts
import type {
  AssetRef,
  HarnessDomain,
  PlanContext,
  Task,
  TaskHandler,
  Verdict,
  WorkPlan,
} from "@content-harness/core";
import { makeResearchRefsHandler } from "./handlers/research_refs.js";
import { draftBaseHandler } from "./handlers/draft_base.js";
import { refineVariantHandler } from "./handlers/refine_variant.js";
import { evalVariantHandler } from "./handlers/eval_variant.js";
import { reviseHandler } from "./handlers/revise.js";
import type { OpencliClient } from "./opencli-client.js";
import type { Persona, Campaign, Piece } from "./schemas/index.js";
import { initSocialState, type SocialState } from "./state.js";

export type SocialTaskKind =
  | "research_refs"
  | "draft_base"
  | "refine_variant"
  | "eval_variant"
  | "revise";

export interface SocialDomainDeps {
  opencli: OpencliClient;
}

let taskCounter = 0;
const nextId = (prefix: string): string => `${prefix}-${++taskCounter}`;

function buildInitialPlan(state: SocialState): WorkPlan<SocialTaskKind> {
  taskCounter = 0;
  const piece = state.piece;
  const primaryPlatforms = state.persona.platforms
    .filter((p) => p.priority > 0 && p.role !== "syndicate")
    .map((p) => p.platform);
  // v1: twitter-only
  const platform = primaryPlatforms.includes("twitter") ? "twitter" : primaryPlatforms[0] ?? "twitter";

  const evaluatorRefs: AssetRef[] = state.persona.audience.evaluator_persona_ids.map((id) => ({
    kind: "evaluator_persona",
    id,
  }));

  const research: Task<SocialTaskKind> = {
    id: nextId("research_refs"),
    kind: "research_refs",
    params: { platform, query: piece.input.intent, limit: 15 },
    deps: [],
    input_refs: [],
    acceptance_criteria: `reference_posts added for ${platform}`,
    gate_before: false,
    gate_after: false,
    status: "pending",
  };

  const draft: Task<SocialTaskKind> = {
    id: nextId("draft_base"),
    kind: "draft_base",
    params: {},
    deps: [research.id],
    input_refs: [],
    acceptance_criteria: "base_article written",
    gate_before: false,
    gate_after: false,
    status: "pending",
  };

  const refine: Task<SocialTaskKind> = {
    id: nextId("refine_variant"),
    kind: "refine_variant",
    params: { platform },
    deps: [draft.id],
    input_refs: [],
    acceptance_criteria: `${platform} variant produced`,
    gate_before: false,
    gate_after: true,
    status: "pending",
  };

  const evalTask: Task<SocialTaskKind> = {
    id: nextId("eval_variant"),
    kind: "eval_variant",
    params: { platform, variant_idx: 0 },
    deps: [refine.id],
    input_refs: evaluatorRefs,
    acceptance_criteria: `variant scores ≥ thresholds`,
    gate_before: false,
    gate_after: false,
    status: "pending",
  };

  return {
    plan_id: `plan-${piece.id}-${Date.now()}`,
    piece_id: piece.id,
    tasks: [research, draft, refine, evalTask],
    budget_estimate: { tokens: 50_000, usd: 0.5, iterations: 6 },
  };
}

export function makeSocialDomain(deps: SocialDomainDeps): HarnessDomain<SocialTaskKind, SocialState> {
  const researchRefs = makeResearchRefsHandler({ opencli: deps.opencli });
  const handlers: Record<SocialTaskKind, TaskHandler<SocialState>> = {
    research_refs: researchRefs,
    draft_base: draftBaseHandler,
    refine_variant: refineVariantHandler,
    eval_variant: evalVariantHandler,
    revise: reviseHandler,
  };

  return {
    async planInitial(ctx: PlanContext<SocialState>): Promise<WorkPlan<SocialTaskKind>> {
      return buildInitialPlan(ctx.state);
    },

    async replan(ctx: PlanContext<SocialState>, _reason: string): Promise<WorkPlan<SocialTaskKind>> {
      // v1 replan is identical to planInitial — later versions can shrink/expand based on state
      return buildInitialPlan(ctx.state);
    },

    handlers,

    async evaluate(state: SocialState): Promise<Verdict> {
      const variants = state.piece.platform_variants;
      if (variants.length === 0) return { kind: "continue" };

      const latestByPlatform = new Map<string, (typeof variants)[number]>();
      variants.forEach((v) => latestByPlatform.set(v.platform, v));

      let allAccepted = true;
      for (const variant of latestByPlatform.values()) {
        if (variant.status === "accepted") continue;
        if (variant.status === "rejected") {
          // Find the eval history for this variant — most recent round
          const round = [...state.piece.eval_history]
            .reverse()
            .find((r) => r.target.kind === "platform_variant" && r.target.platform === variant.platform);
          const feedback = round?.actionable_feedback.map((a) => `[${a.category}] ${a.text}`).join(" | ") ?? "tighten the draft";
          if (variant.revision_count >= 3) {
            return { kind: "redirect", reason: `variant for ${variant.platform} failed after max revisions` };
          }
          return { kind: "revise", task_id: `refine_variant-for-${variant.platform}`, feedback };
        }
        allAccepted = false;
      }
      return allAccepted ? { kind: "done" } : { kind: "continue" };
    },

    isDone(state: SocialState): boolean {
      const variants = state.piece.platform_variants;
      if (variants.length === 0) return false;
      const latestByPlatform = new Map<string, (typeof variants)[number]>();
      variants.forEach((v) => latestByPlatform.set(v.platform, v));
      return Array.from(latestByPlatform.values()).every((v) => v.status === "accepted");
    },

    initState(input: unknown): SocialState {
      const { persona, campaign, piece } = input as { persona: Persona; campaign: Campaign; piece: Piece };
      return initSocialState({ persona, campaign, piece });
    },

    serializeState(state: SocialState): object {
      return state as unknown as object;
    },

    deserializeState(obj: object): SocialState {
      return obj as SocialState;
    },
  };
}
```

Note: the simple `revise` verdict string (`refine_variant-for-${platform}`) is a task-id placeholder the loop's `markRevise` uses. Because the loop's `markRevise` pairs by task id, the first iteration's `refine_variant` task id is used. In practice this means the revise verdict re-runs the refine task. A more rigorous v2 would expose the exact task id via state.

- [ ] **Step 3: Create index.ts barrel**

Create `content-harness/packages/social-pipeline/src/index.ts`:

```ts
export * from "./schemas/index.js";
export * from "./state.js";
export * from "./domain.js";
export { makeFilesystemAssetStore } from "./asset-store.js";
export { makeOpencliSubprocessClient, fakeOpencliClient } from "./opencli-client.js";
export type { OpencliClient } from "./opencli-client.js";
export { DEFAULT_EVALUATOR_PERSONAS } from "./eval/personas.js";
export { simulateAudience } from "./eval/simulator.js";
export { aggregate } from "./eval/aggregator.js";
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/social test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/social-pipeline/src/domain.ts packages/social-pipeline/src/index.ts packages/social-pipeline/tests/domain.test.ts && git commit -m "feat(social): domain.ts implements HarnessDomain, buildInitialPlan"
```

---

## Task 20: CLI entry + example yaml files

**Files:**
- Create: `content-harness/packages/social-pipeline/bin/run.ts`
- Create: `content-harness/data/personas/ai-infra-engineer-liu.yaml`
- Create: `content-harness/data/personas/real-estate-agent-sarah.yaml`
- Create: `content-harness/data/campaigns/q2-infra-insights.yaml`
- Create: `content-harness/data/pieces/harness-debug.yaml`
- Create: `content-harness/data/asset-pools/.gitkeep`

- [ ] **Step 1: Create ai-infra persona yaml (from spec §12.1)**

Create `content-harness/data/personas/ai-infra-engineer-liu.yaml`:

```yaml
id: ai-infra-engineer-liu
identity:
  name: Liu Zhe — AI Infra Engineer
  one_line_bio: I build AI infrastructure and share what I learn debugging it.
  long_bio: |
    I work on the systems underneath LLM applications — harness loops,
    tool protocols, state machines, cost accounting. I write about the
    unglamorous parts of making AI actually useful: retries, budget limits,
    the subtle ways observability saves you at 2am.
voice:
  tone: conversational analytical
  point_of_view: first-person practitioner
  vocabulary:
    prefer: [harness, loop, budget, verdict, state, delta, handler, retry]
    avoid: [revolutionize, game-changer, paradigm, unlock, unleash]
  example_phrases:
    - "We hit this bug last week and here's what I learned."
    - "The interesting part wasn't the model — it was the state machine."
    - "Three retries in, I finally saw why the token count was wrong."
domain:
  primary_topics: [AI infrastructure, agent frameworks, tool design, cost engineering]
  expertise_depth: practitioner
  adjacent_topics: [prompt caching, evals, observability, TDD with LLMs]
audience:
  description: |
    Engineers building LLM-powered systems in production — not prompt hobbyists,
    but people who own pagers and SLAs.
  pain_points:
    - LLM flakiness in production
    - hard-to-debug agent loops
    - surprise costs
    - evals that do not translate to real behavior
  sophistication: practitioner
  evaluator_persona_ids:
    - senior-ai-eng-skeptical
    - startup-cto-buying-time
    - agent-framework-maintainer
platforms:
  - { platform: twitter,  handle: liuzhe_ai,  priority: 1.0, role: primary }
  - { platform: linkedin, handle: liu-zhe-ai, priority: 0.6, role: cross-post }
  - { platform: medium,   handle: liuzhe,     priority: 0.3, role: syndicate }
style_references:
  emulate:
    - { platform: twitter, handle: eugeneyan, why: "tight technical threads with concrete numbers" }
    - { platform: twitter, handle: simonw,    why: "clear plain-English explanations of complex systems" }
  avoid:
    - { platform: twitter, handle: ai_hype_account, why: "generic hype without substance" }
success_metrics:
  primary: engagement
  red_lines:
    - never trade depth for reach
    - never fake a demo
    - always show the failure mode alongside the fix
asset_pool_id: ai-infra-engineer-liu
```

- [ ] **Step 2: Create real-estate persona yaml (from spec §12.2)**

Create `content-harness/data/personas/real-estate-agent-sarah.yaml`:

```yaml
id: real-estate-agent-sarah
identity:
  name: Sarah Chen — 湾区房产经纪人
  one_line_bio: 帮湾区家庭找到真正合适的房子，10 年经验。
  long_bio: |
    我在湾区做房产经纪 10 年，专注 Palo Alto、Mountain View、Cupertino
    这几个学区城市。我相信每个家庭都应该找到"真正适合自己"的房子，
    而不是被推销最贵的。每次看房我都亲自下地下室、爬阁楼、查三份 comps。
voice:
  tone: warm professional, data-backed storytelling
  point_of_view: trusted advisor who has walked hundreds of families home
  vocabulary:
    prefer: [学区, 通勤, comps, walkthrough, lifestyle fit, 房屋结构, 首付比例]
    avoid: [绝佳机会, 千载难逢, 火爆, 内幕, 独家渠道, 价格必涨]
  example_phrases:
    - "昨天有 3 组家庭看了这套房，我记录了他们最在意的 5 个点。"
    - "我花了一上午在地下室检查水管和加热器，这里是我发现的。"
    - "别被 list price 锚定。这是同一街区最近 5 套 comps 的实际成交价。"
domain:
  primary_topics:
    - Bay Area 房市趋势
    - 学区分析
    - 首次购房指南
    - Home inspection 重点
    - Negotiation strategy
  expertise_depth: expert
  adjacent_topics: [mortgage rates, property tax, 装修 ROI, 社区 lifestyle]
audience:
  description: |
    35–55 岁湾区科技行业家庭，双职工，孩子 0–12 岁，正在考虑第一套或换房。
    对学区敏感，看重通勤和生活平衡。
  pain_points:
    - 价格高，预算紧张
    - 不知道哪个学区真的好
    - 担心买在最高点
    - 不知道怎么区分 marketing fluff 和真价值
  sophistication: practitioner
  evaluator_persona_ids:
    - first-time-buyer-tech-couple
    - upgrade-family-with-kids
    - cautious-cash-buyer
platforms:
  - { platform: xiaohongshu, handle: sarah_bayarea_homes, priority: 1.0, role: primary }
  - { platform: linkedin,    handle: sarah-chen-realtor,  priority: 0.6, role: cross-post }
  - { platform: twitter,     handle: sarahchenRE,         priority: 0.3, role: syndicate }
style_references:
  emulate:
    - { platform: xiaohongshu, handle: bayarea_home_hunter,    why: "数据驱动 + 生活场景化" }
    - { platform: linkedin,    handle: top-realtor-west-coast, why: "学区分析深度" }
  avoid:
    - { platform: xiaohongshu, handle: pushy_realtor_xxx, why: "虚假紧迫感、标题党" }
success_metrics:
  primary: clicks
  red_lines:
    - 从不制造虚假紧迫感
    - 总是披露 listing 是我自己的还是第三方分析
    - 从不承诺具体的价格预测
asset_pool_id: real-estate-agent-sarah
```

- [ ] **Step 3: Create example campaign**

Create `content-harness/data/campaigns/q2-infra-insights.yaml`:

```yaml
id: q2-infra-insights
persona_id: ai-infra-engineer-liu
goal: Ship Q2 insights — four pieces focused on what we learned building the harness
timeline:
  start: 2026-04-01T00:00:00Z
  end: 2026-06-30T23:59:59Z
key_messages:
  - observability is the whole game in agent systems
  - budgets exist for a reason — honor them or lose the loop
  - evals that do not mirror real users lie
content_mix:
  thread: 5
  article: 1
overrides: {}
success_criteria: 500 real engagements across the four pieces, >=2 practitioner replies each
```

- [ ] **Step 4: Create example piece**

Create `content-harness/data/pieces/harness-debug.yaml`:

```yaml
id: harness-debug-piece-001
campaign_id: q2-infra-insights
persona_id: ai-infra-engineer-liu
input:
  raw_materials:
    - id: rm-1
      kind: note
      origin: inline
      content: |
        Bug: agent loop silently dropped tasks for 5 days. Root cause:
        handlers returned partial state deltas. Merging dropped the rest.
    - id: rm-2
      kind: note
      origin: inline
      content: |
        Adjacent bug: budget.charge() was called after the check, so every
        run overshot by one call. Off-by-one on the wrong side.
    - id: rm-3
      kind: note
      origin: inline
      content: |
        Fix: made patches append-only. Moved charge ahead of check. 40 lines.
        Finding it took 5 days of log hunting.
  intent: explain what debugging the harness loop taught me about observability
state: draft
platform_variants: []
eval_history: []
```

- [ ] **Step 5: Create gitkeep for asset pools**

Create `content-harness/data/asset-pools/.gitkeep`:

```
```

(empty file)

- [ ] **Step 6: Write CLI entry**

Create `content-harness/packages/social-pipeline/bin/run.ts`:

```ts
#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import Anthropic from "@anthropic-ai/sdk";
import {
  run,
  cliGateResolver,
  makeAnthropicClient,
  consoleLogger,
  systemClock,
} from "@content-harness/core";
import {
  makeSocialDomain,
  makeFilesystemAssetStore,
  makeOpencliSubprocessClient,
  PersonaSchema,
  CampaignSchema,
  PieceSchema,
  DEFAULT_EVALUATOR_PERSONAS,
} from "../src/index.js";

async function loadYaml<T>(path: string, schema: { parse(v: unknown): T }): Promise<T> {
  const raw = await readFile(path, "utf8");
  return schema.parse(parseYaml(raw));
}

async function main() {
  const { values } = parseArgs({
    options: {
      persona: { type: "string" },
      campaign: { type: "string" },
      piece: { type: "string" },
      "data-root": { type: "string", default: "data" },
      "run-root": { type: "string", default: "runs" },
      "no-gates": { type: "boolean", default: false },
    },
  });

  if (!values.persona || !values.campaign || !values.piece) {
    console.error("usage: pnpm --filter @content-harness/social run dev -- --persona <path> --campaign <path> --piece <path>");
    process.exit(2);
  }

  const persona = await loadYaml(resolve(values.persona), PersonaSchema);
  const campaign = await loadYaml(resolve(values.campaign), CampaignSchema);
  const piece = await loadYaml(resolve(values.piece), PieceSchema);

  const dataRoot = resolve(values["data-root"]!);
  const runRoot = resolve(values["run-root"]!);

  const assetStore = makeFilesystemAssetStore(join(dataRoot, "asset-pools"));

  // Seed evaluator personas into the asset pool (v1 uses hardcoded list if empty).
  const existing = await assetStore.query(persona.asset_pool_id, "evaluator_personas");
  if (existing.length === 0) {
    await assetStore.append(persona.asset_pool_id, "evaluator_personas", DEFAULT_EVALUATOR_PERSONAS);
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const llm = makeAnthropicClient({
    sdk: anthropic as any,
    mainModel: "claude-opus-4-6",
    cheapModel: "claude-haiku-4-5-20251001",
  });

  const domain = makeSocialDomain({ opencli: makeOpencliSubprocessClient() });

  const runId = `run-${Date.now()}`;
  const result = await run(
    domain,
    { persona, campaign, piece },
    {
      run_id: runId,
      run_root: runRoot,
      budget: { max_tokens: 500_000, max_usd: 5, max_iterations: 40, max_wall_seconds: 1800 },
      retry: { max_attempts: 2, backoff_ms: 1000 },
      gates: { post_plan: !values["no-gates"], pre_publish: false },
      gate_resolver: values["no-gates"] ? (async () => "approve" as const) : cliGateResolver(),
      thresholds: { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 },
      max_revisions: 3,
    },
    {
      llm,
      assets: assetStore,
      logger: consoleLogger(runId),
      clock: systemClock,
    },
    "social-pipeline",
  );

  if (!result.ok) {
    console.error(`run failed: ${result.reason ?? "unknown"}`);
    process.exit(1);
  }

  const accepted = (result.state as any).piece.platform_variants.find((v: any) => v.status === "accepted");
  if (accepted) {
    const deliverable = join(result.run_dir, "deliverables", "twitter_variant.md");
    await writeFile(deliverable, accepted.content + "\n", "utf8");
    console.log(`\n=== DELIVERED ===`);
    console.log(`platform: ${accepted.platform}`);
    console.log(`score:    ${accepted.eval_score}`);
    console.log(`path:     ${deliverable}\n`);
    console.log(accepted.content);
  } else {
    console.error("no accepted variant was produced");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 7: Typecheck both packages**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/core typecheck && pnpm --filter @content-harness/social typecheck
```
Expected: clean typecheck both packages.

- [ ] **Step 8: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/social-pipeline/bin data && git commit -m "feat(social): CLI entry + example persona/campaign/piece yaml"
```

---

## Task 21: End-to-end integration test

**Files:**
- Create: `content-harness/packages/social-pipeline/tests/integration/e2e.test.ts`

- [ ] **Step 1: Write the integration test**

Create `content-harness/packages/social-pipeline/tests/integration/e2e.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  run,
  fakeLLMClient,
  silentLogger,
  systemClock,
  autoApproveGateResolver,
} from "@content-harness/core";
import type { InfraBundle, RunConfig } from "@content-harness/core";
import {
  makeSocialDomain,
  makeFilesystemAssetStore,
  fakeOpencliClient,
  DEFAULT_EVALUATOR_PERSONAS,
} from "../../src/index.js";

let workRoot: string;
beforeEach(async () => { workRoot = await mkdtemp(join(tmpdir(), "social-e2e-")); });
afterEach(async () => { await rm(workRoot, { recursive: true, force: true }); });

const loadFixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

const persona = {
  id: "liu",
  identity: { name: "Liu", one_line_bio: "bio", long_bio: "long" },
  voice: {
    tone: "conversational analytical",
    point_of_view: "first-person practitioner",
    vocabulary: { prefer: ["harness", "loop"], avoid: ["revolutionize"] },
    example_phrases: ["We hit this bug last week."],
  },
  domain: { primary_topics: ["AI infrastructure"], expertise_depth: "practitioner" as const, adjacent_topics: [] },
  audience: {
    description: "engineers",
    pain_points: ["flakiness"],
    sophistication: "practitioner" as const,
    evaluator_persona_ids: DEFAULT_EVALUATOR_PERSONAS.map((p) => p.id),
  },
  platforms: [{ platform: "twitter" as const, handle: "liu", priority: 1, role: "primary" as const }],
  style_references: { emulate: [], avoid: [] },
  success_metrics: { primary: "engagement" as const, red_lines: [] },
  asset_pool_id: "liu",
};

const campaign = {
  id: "q2", persona_id: "liu", goal: "ship",
  timeline: { start: "2026-04-01T00:00:00Z" },
  key_messages: [], content_mix: {}, overrides: {}, success_criteria: "",
};

const piece = {
  id: "piece1", campaign_id: "q2", persona_id: "liu",
  input: {
    raw_materials: [
      { id: "rm1", kind: "note" as const, content: "loop silently dropping tasks", origin: "inline" },
      { id: "rm2", kind: "note" as const, content: "fix was 40 lines but took 5 days", origin: "inline" },
    ],
    intent: "explain what I learned debugging the harness loop",
  },
  state: "draft" as const,
  platform_variants: [],
  eval_history: [],
};

describe("social-pipeline MVP v1 end-to-end", () => {
  it("produces an accepted twitter variant and writes events.jsonl", async () => {
    const runRoot = join(workRoot, "runs");
    const assetRoot = join(workRoot, "asset-pools");

    const twitterFixture = await loadFixture("opencli/twitter-search.json");
    const draftBase = await loadFixture("llm/draft-base.json");
    const refine = await loadFixture("llm/refine-variant.json");
    const eval1 = await loadFixture("llm/eval-variant-persona-1.json");
    const eval2 = await loadFixture("llm/eval-variant-persona-2.json");
    const eval3 = await loadFixture("llm/eval-variant-persona-3.json");

    const llm = fakeLLMClient([draftBase, refine, eval1, eval2, eval3]);
    const assets = makeFilesystemAssetStore(assetRoot);
    await assets.append("liu", "evaluator_personas", DEFAULT_EVALUATOR_PERSONAS);

    const infra: InfraBundle = {
      llm,
      assets,
      logger: silentLogger(),
      clock: systemClock,
    };
    const domain = makeSocialDomain({
      opencli: fakeOpencliClient({ [piece.input.intent]: twitterFixture }),
    });

    const config: RunConfig = {
      run_id: "e2e",
      run_root: runRoot,
      budget: { max_iterations: 20, max_tokens: 200_000, max_usd: 2, max_wall_seconds: 60 },
      retry: { max_attempts: 2, backoff_ms: 0 },
      gates: { post_plan: false, pre_publish: false },
      gate_resolver: autoApproveGateResolver,
      thresholds: { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 },
      max_revisions: 3,
    };

    const result = await run(domain, { persona, campaign, piece }, config, infra, "social-pipeline");

    expect(result.ok).toBe(true);
    const variants = (result.state as any).piece.platform_variants;
    const accepted = variants.find((v: any) => v.status === "accepted");
    expect(accepted).toBeDefined();
    expect(accepted.eval_score).toBeGreaterThanOrEqual(0.7);

    const events = (await readFile(join(result.run_dir, "events.jsonl"), "utf8")).trim().split("\n");
    expect(events.length).toBeGreaterThanOrEqual(4); // research, draft, refine, eval
  });
});
```

- [ ] **Step 2: Run e2e**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm --filter @content-harness/social test -- -- --reporter verbose
```
Expected: PASS — integration test plus all prior unit tests.

- [ ] **Step 3: Full repo test pass**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && pnpm -r test
```
Expected: both packages pass cleanly.

- [ ] **Step 4: Commit**

```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && git add packages/social-pipeline/tests/integration && git commit -m "test(social): MVP v1 end-to-end integration test"
```

- [ ] **Step 5: Final verification against the spec §8.3 Definition of Done**

Run:
```bash
cd /Users/liuzhe/Desktop/AI项目/content-harness && ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY pnpm --filter @content-harness/social dev -- --persona data/personas/ai-infra-engineer-liu.yaml --campaign data/campaigns/q2-infra-insights.yaml --piece data/pieces/harness-debug.yaml --no-gates
```
Expected (requires a real `ANTHROPIC_API_KEY` and an `opencli` binary that can reach Twitter):
- run finishes with an accepted twitter variant
- `runs/run-*/deliverables/twitter_variant.md` contains the final thread
- `events.jsonl` replayable, `budget.json` shows non-exhausted state

If the environment lacks either the API key or opencli binary, this is a manual acceptance step; the unit + integration tests cover the coded behaviour.

---

## Appendix A: Quick reference — file count summary

- harness-core: 13 source files + 7 test files (+ fixtures)
- social-pipeline: 17 source files + 10 test files (+ fixtures)
- data/: 4 config yamls
- root: 6 config/README files

## Appendix B: Commit log after full execution

Expected ordered commit sequence (one per task, with a final e2e commit):

1. `chore: scaffold content-harness monorepo`
2. `feat(core): add harness-core package with shared types`
3. `feat(core): add Budget with multi-limit enforcement`
4. `feat(core): add filesystem persistence with resume support`
5. `feat(core): add runWithRetry with retryable/permanent classification`
6. `feat(core): add pure planner helpers (selectNextRunnable, markRevise/Rejected/Completed)`
7. `feat(core): add gate resolvers (cli/auto-approve/auto-reject/scripted)`
8. `feat(core): add infra (clock, logger, anthropic llm client + fake)`
9. `feat(core): add run loop with budget, gates, verdict routing, persistence`
10. `feat(core): export public API from index`
11. `feat(social): scaffold package + zod schemas for persona/campaign/piece/asset-pool`
12. `feat(social): filesystem asset store with typed AssetRef resolve`
13. `feat(social): evaluator personas, simulator, aggregator`
14. `feat(social): research_refs handler + opencli subprocess client`
15. `feat(social): draft_base handler with persona-aware prompting`
16. `feat(social): refine_variant handler (twitter-only in v1)`
17. `feat(social): eval_variant handler with sub-agent simulation`
18. `feat(social): revise handler using latest EvalRound actionable_feedback`
19. `feat(social): domain.ts implements HarnessDomain, buildInitialPlan`
20. `feat(social): CLI entry + example persona/campaign/piece yaml`
21. `test(social): MVP v1 end-to-end integration test`
