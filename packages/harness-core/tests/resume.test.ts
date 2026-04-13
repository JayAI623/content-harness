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
