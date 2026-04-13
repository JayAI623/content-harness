import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { evalVariantHandler } from "../../src/handlers/eval_variant.js";
import { DEFAULT_EVALUATOR_PERSONAS } from "../../src/eval/personas.js";
import { fakeLLMClient, silentLogger, systemClock } from "@content-harness/core";
import type { AssetRef, InfraBundle, Task } from "@content-harness/core";
import { initSocialState } from "../../src/state.js";

const loadFixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`../fixtures/llm/${name}`, import.meta.url), "utf8"));

const persona = {
  id: "liu",
  identity: { name: "Liu", one_line_bio: "", long_bio: "" },
  voice: { tone: "analytic", point_of_view: "first-person", vocabulary: { prefer: [], avoid: [] }, example_phrases: [] },
  domain: { primary_topics: [], expertise_depth: "practitioner" as const, adjacent_topics: [] },
  audience: {
    description: "eng",
    pain_points: [],
    sophistication: "practitioner" as const,
    evaluator_persona_ids: DEFAULT_EVALUATOR_PERSONAS.map((p) => p.id),
  },
  platforms: [{ platform: "twitter" as const, handle: "liu", priority: 1, role: "primary" as const }],
  style_references: { emulate: [], avoid: [] },
  success_metrics: { primary: "engagement" as const, red_lines: [] },
  asset_pool_id: "liu",
};

const campaign = {
  id: "q2", persona_id: "liu", goal: "ship",
  timeline: { start: "2026-04-01T00:00:00Z" },
  key_messages: [], content_mix: {}, overrides: {}, success_criteria: "",
};

const pieceWithVariant = {
  id: "piece1", campaign_id: "q2", persona_id: "liu",
  input: { raw_materials: [], intent: "explain" },
  state: "evaluating" as const,
  platform_variants: [{
    platform: "twitter",
    content: "1/ harness bug story",
    constraints_applied: [],
    inspired_by: [],
    style_patterns_applied: [],
    status: "pending_eval" as const,
    revision_count: 0,
  }],
  eval_history: [],
};

const fakeAssetsWithPersonas = () => ({
  async append() {},
  async query() { return []; },
  async resolve<T>(_pool: string, ref: AssetRef): Promise<T | null> {
    if (ref.kind !== "evaluator_persona") return null;
    const p = DEFAULT_EVALUATOR_PERSONAS.find((ep) => ep.id === ref.id);
    return (p as T | undefined) ?? null;
  },
  async putBlob() { return ""; },
  async getBlob() { return null; },
});

describe("eval_variant handler", () => {
  it("dispatches simulator, aggregates, appends EvalRound, marks variant accepted", async () => {
    const f1 = await loadFixture("eval-variant-persona-1.json");
    const f2 = await loadFixture("eval-variant-persona-2.json");
    const f3 = await loadFixture("eval-variant-persona-3.json");
    const llm = fakeLLMClient([f1, f2, f3]);
    const infra: InfraBundle = {
      llm,
      assets: fakeAssetsWithPersonas(),
      logger: silentLogger(),
      clock: systemClock,
    };
    const task: Task<string> = {
      id: "eval_twitter",
      kind: "eval_variant",
      params: { platform: "twitter", variant_idx: 0 },
      deps: [],
      input_refs: DEFAULT_EVALUATOR_PERSONAS.map((p) => ({ kind: "evaluator_persona" as const, id: p.id })),
      acceptance_criteria: "",
      gate_before: false,
      gate_after: false,
      status: "pending",
    };
    const state = initSocialState({ persona, campaign, piece: pieceWithVariant });
    const delta = await evalVariantHandler(task, state, infra);
    expect(delta.kind).toBe("success");
    expect(delta.patches.some((p) => p.op === "append" && p.path.join(".") === "piece.eval_history")).toBe(true);
    const statusPatch = delta.patches.find((p) => p.path.includes("status"));
    expect(statusPatch?.value).toBe("accepted");
    expect(delta.cost.input_tokens).toBe(1200);
    expect(delta.cost.output_tokens).toBe(240);
    expect(delta.cost.usd).toBeCloseTo(0.006);
  });

  it("marks variant rejected when thresholds fail", async () => {
    const failing = {
      text: JSON.stringify({ understood: true, engagement_likelihood: 0.4, ai_smell_score: 0.6, depth_score: 0.3, comments: "too generic" }),
      cost: { input_tokens: 400, output_tokens: 80, usd: 0.002 },
      stop_reason: "end_turn",
    };
    const llm = fakeLLMClient([failing, failing, failing]);
    const infra: InfraBundle = {
      llm,
      assets: fakeAssetsWithPersonas(),
      logger: silentLogger(),
      clock: systemClock,
    };
    const task: Task<string> = {
      id: "eval_twitter",
      kind: "eval_variant",
      params: { platform: "twitter", variant_idx: 0 },
      deps: [],
      input_refs: DEFAULT_EVALUATOR_PERSONAS.map((p) => ({ kind: "evaluator_persona" as const, id: p.id })),
      acceptance_criteria: "",
      gate_before: false,
      gate_after: false,
      status: "pending",
    };
    const state = initSocialState({ persona, campaign, piece: pieceWithVariant });
    const delta = await evalVariantHandler(task, state, infra);
    expect(delta.kind).toBe("success");
    const statusPatch = delta.patches.find((p) => p.path.includes("status"));
    expect(statusPatch?.value).toBe("rejected");
    expect(delta.cost.input_tokens).toBe(1200);
    expect(delta.cost.output_tokens).toBe(240);
    expect(delta.cost.usd).toBeCloseTo(0.006);
  });
});
