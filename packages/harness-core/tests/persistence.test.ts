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
