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
