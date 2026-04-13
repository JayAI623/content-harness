import { Budget } from "./budget.js";
import { applyDelta } from "./patch.js";
import { appendEvent, createRun, snapshot } from "./persistence.js";
import { hasFailed, markCompleted, markFailed, markRevise, selectNextRunnable, markRejected } from "./planner.js";
import { runWithRetry } from "./retry.js";
import type {
  HarnessDomain,
  InfraBundle,
  RunConfig,
  RunResult,
  WorkPlan,
} from "./types.js";

export async function run<TK extends string, S>(
  domain: HarnessDomain<TK, S>,
  input: unknown,
  config: RunConfig<TK, S>,
  infra: InfraBundle,
  domainId: string,
): Promise<RunResult<S>> {
  async function maybePrePublishReject(
    state: S,
    budget: Budget,
    runDir: string,
  ): Promise<RunResult<S> | null> {
    if (!config.gates.pre_publish) return null;
    const decision = await config.gate_resolver({ kind: "pre_publish", state });
    if (decision === "reject") {
      return { ok: false, state, budget: budget.snapshot(), reason: "pre_publish gate rejected", run_dir: runDir };
    }
    return null;
  }

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
    stuckChecks = 0;

    if (task.gate_before) {
      const decision = await config.gate_resolver({ kind: "task_gate_before", task });
      if (decision === "reject") {
        plan = markRejected(plan, task);
        continue;
      }
    }

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

    state = applyDelta(state, delta);
    budget.charge(delta.cost);
    budget.tickIteration();

    if (delta.kind === "success") {
      plan = markCompleted(plan, task.id);
    } else {
      plan = markFailed(plan, task.id);
    }

    if (task.gate_after) {
      const decision = await config.gate_resolver({ kind: "task_gate_after", task, delta });
      if (decision === "reject") {
        plan = markRevise(plan, task.id, "user rejected at post-task gate");
        await appendEvent(runDir, { task, delta });
        await snapshot(runDir, { state: domain.serializeState(state), plan, budget: budget.snapshot() });
        continue;
      }
    }

    const verdict = await domain.evaluate({ state, config });
    await appendEvent(runDir, { task, delta, verdict });
    await snapshot(runDir, { state: domain.serializeState(state), plan, budget: budget.snapshot() });

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
  }

  if (budget.exhausted()) {
    return { ok: false, state, budget: budget.snapshot(), reason: `budget exhausted (${budget.snapshot().limit_hit})`, run_dir: runDir };
  }
  const rejection = await maybePrePublishReject(state, budget, runDir);
  if (rejection) return rejection;
  return { ok: true, state, budget: budget.snapshot(), run_dir: runDir };
}
