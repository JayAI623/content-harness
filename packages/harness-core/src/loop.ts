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
      const verdict = await domain.evaluate({ state, config });
      if (verdict.kind === "abort") {
        return { ok: false, state, budget: budget.snapshot(), reason: verdict.reason, run_dir: runDir };
      }
      if (verdict.kind === "redirect") {
        plan = await domain.replan({ state, config }, verdict.reason);
        continue;
      }
      continue;
    }

    const verdict = await domain.evaluate({ state, config });
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
