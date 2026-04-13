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

  it("resolves pre_publish events through auto resolvers", async () => {
    const event: GateEvent<"k", { count: number }> = {
      kind: "pre_publish",
      state: { count: 42 },
    };
    expect(await autoApproveGateResolver(event)).toBe("approve");
    expect(await autoRejectGateResolver(event)).toBe("reject");
  });
});
