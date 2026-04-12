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
