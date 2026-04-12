import { describe, it, expect } from "vitest";
import { PersonaSchema, CampaignSchema, PieceSchema, AssetPoolSchema } from "../src/schemas/index.js";

describe("PersonaSchema", () => {
  it("accepts a minimal valid persona", () => {
    const p = PersonaSchema.parse({
      id: "liu",
      identity: { name: "Liu", one_line_bio: "bio", long_bio: "long" },
      voice: {
        tone: "analytic",
        point_of_view: "first-person",
        vocabulary: { prefer: ["harness"], avoid: ["hype"] },
        example_phrases: ["hi"],
      },
      domain: { primary_topics: ["ai"], expertise_depth: "practitioner", adjacent_topics: [] },
      audience: {
        description: "engineers",
        pain_points: ["cost"],
        sophistication: "practitioner",
        evaluator_persona_ids: ["e1"],
      },
      platforms: [{ platform: "twitter", handle: "liu", priority: 1, role: "primary" }],
      style_references: { emulate: [], avoid: [] },
      success_metrics: { primary: "engagement", red_lines: ["no hype"] },
      asset_pool_id: "liu",
    });
    expect(p.id).toBe("liu");
  });

  it("rejects unknown platform", () => {
    expect(() =>
      PersonaSchema.parse({
        id: "x",
        identity: { name: "x", one_line_bio: "", long_bio: "" },
        voice: { tone: "", point_of_view: "", vocabulary: { prefer: [], avoid: [] }, example_phrases: [] },
        domain: { primary_topics: [], expertise_depth: "practitioner", adjacent_topics: [] },
        audience: { description: "", pain_points: [], sophistication: "practitioner", evaluator_persona_ids: [] },
        platforms: [{ platform: "tiktok", handle: "x", priority: 1, role: "primary" }],
        style_references: { emulate: [], avoid: [] },
        success_metrics: { primary: "engagement", red_lines: [] },
        asset_pool_id: "x",
      }),
    ).toThrow();
  });
});

describe("CampaignSchema", () => {
  it("accepts valid campaign", () => {
    const c = CampaignSchema.parse({
      id: "q2",
      persona_id: "liu",
      goal: "launch",
      timeline: { start: "2026-04-01T00:00:00Z" },
      key_messages: ["msg"],
      content_mix: { thread: 5 },
      overrides: {},
      success_criteria: "growth",
    });
    expect(c.id).toBe("q2");
  });
});

describe("PieceSchema", () => {
  it("accepts a draft piece with raw materials", () => {
    const p = PieceSchema.parse({
      id: "piece1",
      campaign_id: "q2",
      persona_id: "liu",
      input: {
        raw_materials: [{ id: "rm1", kind: "text", content: "hello", origin: "inline" }],
        intent: "explain the loop",
      },
      state: "draft",
      platform_variants: [],
      eval_history: [],
    });
    expect(p.state).toBe("draft");
  });
});

describe("AssetPoolSchema", () => {
  it("accepts an empty pool", () => {
    const pool = AssetPoolSchema.parse({
      persona_id: "liu",
      reference_posts: [],
      style_patterns: [],
      hot_topics: [],
      evaluator_personas: [],
      own_history: [],
    });
    expect(pool.persona_id).toBe("liu");
  });
});
