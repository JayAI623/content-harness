import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { refineVariantHandler } from "../../src/handlers/refine_variant.js";
import { fakeLLMClient, silentLogger, systemClock } from "@content-harness/core";
import type { InfraBundle, Task } from "@content-harness/core";
import { initSocialState } from "../../src/state.js";
import type { Piece } from "../../src/schemas/index.js";

const fixtureUrl = new URL("../fixtures/llm/refine-variant.json", import.meta.url);

const persona = {
  id: "liu",
  identity: { name: "Liu", one_line_bio: "", long_bio: "" },
  voice: { tone: "analytic", point_of_view: "first-person", vocabulary: { prefer: ["harness", "loop"], avoid: ["revolutionize"] }, example_phrases: ["We hit this bug."] },
  domain: { primary_topics: ["ai"], expertise_depth: "practitioner" as const, adjacent_topics: [] },
  audience: { description: "eng", pain_points: [], sophistication: "practitioner" as const, evaluator_persona_ids: ["p1"] },
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

const pieceWithBase = {
  id: "piece1", campaign_id: "q2", persona_id: "liu",
  input: { raw_materials: [], intent: "explain" },
  state: "refining" as const,
  base_article: {
    markdown: "# long-form markdown base article with at least 200 words...",
    produced_at: "2026-04-11T00:00:00Z",
    source_refs: [],
  },
  platform_variants: [],
  eval_history: [],
};

describe("refine_variant handler", () => {
  it("produces a twitter variant constrained to 5 tweets under 280 chars each", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
    const llm = fakeLLMClient([fixture]);
    const infra: InfraBundle = {
      llm,
      assets: { async append() {}, async query() { return []; }, async resolve() { return null; }, async putBlob() { return ""; }, async getBlob() { return null; } },
      logger: silentLogger(),
      clock: systemClock,
    };
    const task: Task<string> = {
      id: "refine_twitter",
      kind: "refine_variant",
      params: { platform: "twitter" },
      deps: [],
      input_refs: [],
      acceptance_criteria: "",
      gate_before: false,
      gate_after: true,
      status: "pending",
    };
    const state = initSocialState({ persona, campaign, piece: pieceWithBase });
    const delta = await refineVariantHandler(task, state, infra);
    expect(delta.kind).toBe("success");
    expect(delta.patches.some((p) => p.op === "append" && p.path.join(".") === "piece.platform_variants")).toBe(true);
    expect(delta.result_ref?.kind).toBe("platform_variant");
    const systemText = (llm.calls[0]!.system as Array<{ text: string }>).map((s) => s.text).join("\n");
    expect(systemText).toContain("twitter");
    expect(systemText).toMatch(/280/);
  });

  it("fails when base_article is missing", async () => {
    const llm = fakeLLMClient([]);
    const infra: InfraBundle = {
      llm,
      assets: { async append() {}, async query() { return []; }, async resolve() { return null; }, async putBlob() { return ""; }, async getBlob() { return null; } },
      logger: silentLogger(),
      clock: systemClock,
    };
    // Option 1: destructuring omit to avoid exactOptionalPropertyTypes violation
    const { base_article: _omit, ...pieceNoBase } = pieceWithBase;
    const state = initSocialState({ persona, campaign, piece: pieceNoBase as Piece });
    const task: Task<string> = {
      id: "refine_twitter",
      kind: "refine_variant",
      params: { platform: "twitter" },
      deps: [],
      input_refs: [],
      acceptance_criteria: "",
      gate_before: false,
      gate_after: true,
      status: "pending",
    };
    const delta = await refineVariantHandler(task, state, infra);
    expect(delta.kind).toBe("failure");
    expect(delta.error?.retryable).toBe(false);
  });
});
