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
    expect(delta.patches.some((p) => p.op === "append" && p.path.join(".") === "piece.platform_variants")).toBe(true);
    const userMsg = llm.calls[0]!.messages.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("concrete number");
  });
});
