import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/loop.js";
import { autoApproveGateResolver, scriptedGateResolver } from "../src/gates.js";
import type { GateResolver } from "../src/types.js";
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
    async evaluate({ state }): Promise<Verdict> {
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

  it("resolves ok when handler fails and evaluate returns done", async () => {
    let evaluateCalls = 0;
    let handlerCalls = 0;
    const domain: HarnessDomain<"inc", CountState> = {
      async planInitial() {
        return makePlan([
          {
            id: "t0",
            kind: "inc",
            params: {},
            deps: [],
            input_refs: [],
            acceptance_criteria: "",
            gate_before: false,
            gate_after: false,
            status: "pending",
          },
          {
            id: "t1",
            kind: "inc",
            params: {},
            deps: ["t0"],
            input_refs: [],
            acceptance_criteria: "",
            gate_before: false,
            gate_after: false,
            status: "pending",
          },
        ]);
      },
      async replan() { return makePlan([]); },
      handlers: {
        inc: async (): Promise<Delta<CountState>> => {
          handlerCalls += 1;
          return {
            kind: "failure",
            patches: [],
            cost: { input_tokens: 1, output_tokens: 1, usd: 0 },
            error: { message: "boom", retryable: false },
          };
        },
      },
      async evaluate(): Promise<Verdict> {
        evaluateCalls += 1;
        return { kind: "done" };
      },
      isDone: () => false,
      initState: () => ({ count: 0, doneAfter: 999 }),
      serializeState: (s) => s,
      deserializeState: (o) => o as CountState,
    };

    const result = await run(domain, {}, makeConfig(), makeInfra(), "test-domain");

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(evaluateCalls).toBe(1);
    // The second task must NOT have been dispatched — we stopped on done after the first failure.
    expect(handlerCalls).toBe(1);
  });

  it("routes failure+revise through markRevise so the task becomes pending again", async () => {
    let handlerCalls = 0;
    let evaluateCalls = 0;
    const observedFeedback: string[] = [];
    const domain: HarnessDomain<"inc", CountState> = {
      async planInitial() {
        return makePlan([
          {
            id: "t0",
            kind: "inc",
            params: {},
            deps: [],
            input_refs: [],
            acceptance_criteria: "",
            gate_before: false,
            gate_after: false,
            status: "pending",
          },
        ]);
      },
      async replan() {
        return makePlan([
          {
            id: "t0",
            kind: "inc",
            params: {},
            deps: [],
            input_refs: [],
            acceptance_criteria: "",
            gate_before: false,
            gate_after: false,
            status: "pending",
          },
        ]);
      },
      handlers: {
        inc: async (task): Promise<Delta<CountState>> => {
          handlerCalls += 1;
          if (typeof task.params.revise_feedback === "string") {
            observedFeedback.push(task.params.revise_feedback);
          }
          if (handlerCalls === 1) {
            return {
              kind: "failure",
              patches: [],
              cost: { input_tokens: 1, output_tokens: 1, usd: 0 },
              error: { message: "first attempt fails", retryable: false },
            };
          }
          return {
            kind: "success",
            patches: [{ op: "set", path: ["count"], value: 1 }],
            cost: { input_tokens: 1, output_tokens: 1, usd: 0 },
          };
        },
      },
      async evaluate(): Promise<Verdict> {
        evaluateCalls += 1;
        if (evaluateCalls === 1) {
          return { kind: "revise", task_id: "t0", feedback: "please retry" };
        }
        return { kind: "done" };
      },
      isDone: (state) => state.count >= 1,
      initState: () => ({ count: 0, doneAfter: 1 }),
      serializeState: (s) => s,
      deserializeState: (o) => o as CountState,
    };

    const result = await run(
      domain,
      {},
      makeConfig({ budget: { max_iterations: 5 } }),
      makeInfra(),
      "test-domain",
    );

    expect(result.ok).toBe(true);
    // handler ran once (failure) then again (success after revise)
    expect(handlerCalls).toBe(2);
    // second invocation observed the revise_feedback stamped on params by markRevise
    expect(observedFeedback).toContain("please retry");
  });

  it("emits pre_publish gate on done verdict (approve path)", async () => {
    const domain = countDomain({ tasksToRun: 1 });
    const events: string[] = [];
    const resolver: GateResolver = async (e) => {
      events.push(e.kind);
      return "approve";
    };
    const result = await run(
      domain,
      { doneAfter: 1 },
      makeConfig({ gates: { post_plan: false, pre_publish: true }, gate_resolver: resolver }),
      makeInfra(),
      "test-domain",
    );
    expect(result.ok).toBe(true);
    expect(result.state.count).toBe(1);
    expect(events).toContain("pre_publish");
    // Exactly one pre_publish invocation.
    expect(events.filter((k) => k === "pre_publish").length).toBe(1);
  });

  it("emits pre_publish gate on done verdict (reject path)", async () => {
    const domain = countDomain({ tasksToRun: 1 });
    const resolver = scriptedGateResolver(["reject"]);
    const result = await run(
      domain,
      { doneAfter: 1 },
      makeConfig({ gates: { post_plan: false, pre_publish: true }, gate_resolver: resolver }),
      makeInfra(),
      "test-domain",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/pre.?publish/i);
  });

  it("emits pre_publish gate on natural completion exit (no done verdict)", async () => {
    // A domain where evaluate never returns {kind:"done"} but isDone flips true
    // after the first task. On the next while-check, the loop exits and we hit
    // the bottom `return { ok: true }` — which must also be gated.
    const events: string[] = [];
    const resolver: GateResolver = async (e) => {
      events.push(e.kind);
      return "approve";
    };
    const domain: HarnessDomain<"inc", CountState> = {
      async planInitial() {
        return makePlan([
          {
            id: "t0",
            kind: "inc",
            params: {},
            deps: [],
            input_refs: [],
            acceptance_criteria: "",
            gate_before: false,
            gate_after: false,
            status: "pending",
          },
        ]);
      },
      async replan() { return makePlan([]); },
      handlers: {
        inc: async (_task, state): Promise<Delta<CountState>> => ({
          kind: "success",
          patches: [{ op: "set", path: ["count"], value: state.count + 1 }],
          cost: { input_tokens: 1, output_tokens: 1, usd: 0 },
        }),
      },
      async evaluate(): Promise<Verdict> {
        // never returns done — always "continue"
        return { kind: "continue" };
      },
      isDone: (state) => state.count >= 1,
      initState: () => ({ count: 0, doneAfter: 1 }),
      serializeState: (s) => s,
      deserializeState: (o) => o as CountState,
    };

    const result = await run(
      domain,
      {},
      makeConfig({ gates: { post_plan: false, pre_publish: true }, gate_resolver: resolver }),
      makeInfra(),
      "test-domain",
    );
    expect(result.ok).toBe(true);
    expect(events).toContain("pre_publish");
    expect(events.filter((k) => k === "pre_publish").length).toBe(1);
  });

  it("natural completion pre_publish rejection returns ok:false with reason", async () => {
    const resolver: GateResolver = async (e) => {
      if (e.kind === "pre_publish") return "reject";
      return "approve";
    };
    const domain: HarnessDomain<"inc", CountState> = {
      async planInitial() {
        return makePlan([
          {
            id: "t0",
            kind: "inc",
            params: {},
            deps: [],
            input_refs: [],
            acceptance_criteria: "",
            gate_before: false,
            gate_after: false,
            status: "pending",
          },
        ]);
      },
      async replan() { return makePlan([]); },
      handlers: {
        inc: async (_task, state): Promise<Delta<CountState>> => ({
          kind: "success",
          patches: [{ op: "set", path: ["count"], value: state.count + 1 }],
          cost: { input_tokens: 1, output_tokens: 1, usd: 0 },
        }),
      },
      async evaluate(): Promise<Verdict> { return { kind: "continue" }; },
      isDone: (state) => state.count >= 1,
      initState: () => ({ count: 0, doneAfter: 1 }),
      serializeState: (s) => s,
      deserializeState: (o) => o as CountState,
    };
    const result = await run(
      domain,
      {},
      makeConfig({ gates: { post_plan: false, pre_publish: true }, gate_resolver: resolver }),
      makeInfra(),
      "test-domain",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/pre.?publish/i);
  });

  it("does NOT invoke resolver for pre_publish when gate is disabled", async () => {
    const domain = countDomain({ tasksToRun: 2 });
    const guard: GateResolver = async (e) => {
      if (e.kind === "pre_publish") throw new Error("unexpected pre_publish invocation");
      return "approve";
    };
    const result = await run(
      domain,
      { doneAfter: 2 },
      makeConfig({ gates: { post_plan: false, pre_publish: false }, gate_resolver: guard }),
      makeInfra(),
      "test-domain",
    );
    expect(result.ok).toBe(true);
    expect(result.state.count).toBe(2);
  });

  it("throws a clear error when evaluate returns an unknown verdict kind", async () => {
    const domain: HarnessDomain<"inc", CountState> = {
      async planInitial() {
        return makePlan([
          {
            id: "t0",
            kind: "inc",
            params: {},
            deps: [],
            input_refs: [],
            acceptance_criteria: "",
            gate_before: false,
            gate_after: false,
            status: "pending",
          },
        ]);
      },
      async replan() { return makePlan([]); },
      handlers: {
        inc: async (_task, state): Promise<Delta<CountState>> => ({
          kind: "success",
          patches: [{ op: "set", path: ["count"], value: state.count + 1 }],
          cost: { input_tokens: 1, output_tokens: 1, usd: 0 },
        }),
      },
      async evaluate(): Promise<Verdict> {
        return { kind: "sideways" } as unknown as Verdict;
      },
      isDone: () => false,
      initState: () => ({ count: 0, doneAfter: 999 }),
      serializeState: (s) => s,
      deserializeState: (o) => o as CountState,
    };

    await expect(
      run(domain, {}, makeConfig(), makeInfra(), "test-domain"),
    ).rejects.toThrow(/unhandled verdict kind/);
  });

  it("aborts with a failed-task reason when a task failure leaves nothing runnable", async () => {
    const domain: HarnessDomain<"inc", CountState> = {
      async planInitial() {
        return makePlan([
          {
            id: "t-root",
            kind: "boom" as any,
            params: {},
            deps: [],
            input_refs: [],
            acceptance_criteria: "",
            gate_before: false,
            gate_after: false,
            status: "pending",
          },
          {
            id: "t-dep",
            kind: "noop" as any,
            params: {},
            deps: ["t-root"],
            input_refs: [],
            acceptance_criteria: "",
            gate_before: false,
            gate_after: false,
            status: "pending",
          },
        ]);
      },
      async replan() {
        // Replan rebuilds the identical plan — pre-fix, this is the livelock.
        return makePlan([
          {
            id: "t-root",
            kind: "boom" as any,
            params: {},
            deps: [],
            input_refs: [],
            acceptance_criteria: "",
            gate_before: false,
            gate_after: false,
            status: "pending",
          },
          {
            id: "t-dep",
            kind: "noop" as any,
            params: {},
            deps: ["t-root"],
            input_refs: [],
            acceptance_criteria: "",
            gate_before: false,
            gate_after: false,
            status: "pending",
          },
        ]);
      },
      handlers: {
        boom: async (): Promise<Delta<CountState>> => ({
          kind: "failure",
          patches: [],
          cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
          error: { message: "boom", retryable: false },
        }),
        noop: async (): Promise<Delta<CountState>> => ({
          kind: "success",
          patches: [],
          cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
        }),
      } as any,
      async evaluate(): Promise<Verdict> { return { kind: "continue" }; },
      isDone: () => false,
      initState: () => ({ count: 0, doneAfter: 999 }),
      serializeState: (s) => s,
      deserializeState: (o) => o as CountState,
    };

    const result = await run(
      domain,
      {},
      makeConfig({ budget: { max_iterations: 20 } }),
      makeInfra(),
      "test-domain",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/failed task/);
    expect(result.budget.iterations).toBeLessThan(5);
  });

  it("aborts cleanly when a task kind has no registered handler", async () => {
    const domain: HarnessDomain<"inc", CountState> = {
      async planInitial() {
        return makePlan([
          {
            id: "t-ghost",
            kind: "not_a_real_kind" as any,
            params: {},
            deps: [],
            input_refs: [],
            acceptance_criteria: "",
            gate_before: false,
            gate_after: false,
            status: "pending",
          },
        ]);
      },
      async replan() { throw new Error("should not replan"); },
      handlers: {} as any,
      async evaluate(): Promise<Verdict> { return { kind: "continue" }; },
      isDone: () => false,
      initState: () => ({ count: 0, doneAfter: 999 }),
      serializeState: (s) => s,
      deserializeState: (o) => o as CountState,
    };

    const result = await run(domain, {}, makeConfig(), makeInfra(), "test-domain");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no handler for task kind "not_a_real_kind"/);
  });

  it("does NOT emit pre_publish on non-success exit (budget exhausted)", async () => {
    const domain = countDomain({ tasksToRun: 5 });
    const guard: GateResolver = async (e) => {
      if (e.kind === "pre_publish") throw new Error("unexpected pre_publish invocation");
      return "approve";
    };
    const result = await run(
      domain,
      { doneAfter: 5 },
      makeConfig({
        budget: { max_iterations: 1 },
        gates: { post_plan: false, pre_publish: true },
        gate_resolver: guard,
      }),
      makeInfra(),
      "test-domain",
    );
    expect(result.ok).toBe(false);
    expect(result.budget.limit_hit).toBe("iterations");
  });
});
