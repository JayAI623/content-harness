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
import type { EventEntry } from "../src/persistence.js";
import { writeAtomic } from "../src/persistence-atomic.js";
import type { BudgetSnapshot, Task, Verdict, WorkPlan } from "../src/types.js";

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
    await snapshot(dir, 0, { state: { x: 1 }, plan: fakePlan, budget: { used_tokens: 0, used_usd: 0, iterations: 0, wall_seconds: 0, exhausted: false } });
    await snapshot(dir, 1, { state: { x: 2 }, plan: fakePlan, budget: { used_tokens: 1, used_usd: 0, iterations: 1, wall_seconds: 1, exhausted: false } });
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

  it("appendEvent round-trips verdict field through JSON", async () => {
    const dir = await createRun({
      run_root: runRoot,
      run_id: "r5",
      domain_id: "d",
      started_at: new Date(),
    });
    const verdict: Verdict = { kind: "revise", task_id: "t1", feedback: "x" };
    const entry: EventEntry = {
      task: fakeTask,
      delta: { kind: "success", patches: [], cost: { input_tokens: 1, output_tokens: 2, usd: 0.001 } },
      verdict,
    };
    await appendEvent(dir, entry);
    const raw = await readFile(join(dir, "events.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.verdict).toEqual(verdict);
  });

  it("loadLatestPlan returns the most recent plan snapshot", async () => {
    const dir = await createRun({
      run_root: runRoot,
      run_id: "r4",
      domain_id: "d",
      started_at: new Date(),
    });
    await snapshot(dir, 0, { state: {}, plan: fakePlan, budget: { used_tokens: 0, used_usd: 0, iterations: 0, wall_seconds: 0, exhausted: false } });
    const loaded = await loadLatestPlan<"a">(dir);
    expect(loaded?.plan_id).toBe("p1");
  });
});

describe("snapshot — explicit step", () => {
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

  it("writes state-N and plan-N with the same N", async () => {
    const root = await mkdtemp(join(tmpdir(), "snap-step-"));
    const runDir = await createRun({
      run_root: root,
      run_id: "r1",
      domain_id: "d",
      started_at: new Date(),
    });
    await snapshot(runDir, 0, { state: { x: 1 }, plan: emptyPlan, budget: zeroBudget });
    await snapshot(runDir, 1, { state: { x: 2 }, plan: emptyPlan, budget: zeroBudget });
    const stateEntries = (await readdir(join(runDir, "state"))).sort();
    const planEntries = (await readdir(join(runDir, "plan"))).sort();
    expect(stateEntries).toEqual(["state-0.json", "state-1.json"]);
    expect(planEntries).toEqual(["plan-0.json", "plan-1.json"]);
    // Roundtrip the content so the explicit-step signature is actually exercised
    // rather than the caller accidentally passing the step as the payload.
    const state0 = JSON.parse(await readFile(join(runDir, "state", "state-0.json"), "utf8"));
    const state1 = JSON.parse(await readFile(join(runDir, "state", "state-1.json"), "utf8"));
    expect(state0).toEqual({ x: 1 });
    expect(state1).toEqual({ x: 2 });
  });
});

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
