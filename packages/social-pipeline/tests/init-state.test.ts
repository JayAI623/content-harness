import { describe, it, expect } from "vitest";
import { makeSocialDomain } from "../src/domain.js";
import { fakeOpencliClient } from "../src/opencli-client.js";
import { DEFAULT_EVALUATOR_PERSONAS } from "../src/eval/personas.js";

const persona = {
  id: "liu",
  identity: { name: "Liu", one_line_bio: "", long_bio: "" },
  voice: {
    tone: "analytic",
    point_of_view: "first-person",
    vocabulary: { prefer: [], avoid: [] },
    example_phrases: [],
  },
  domain: { primary_topics: ["ai"], expertise_depth: "practitioner" as const, adjacent_topics: [] },
  audience: {
    description: "eng",
    pain_points: [],
    sophistication: "practitioner" as const,
    evaluator_persona_ids: DEFAULT_EVALUATOR_PERSONAS.map((p) => p.id),
  },
  platforms: [
    { platform: "twitter" as const, handle: "liu", priority: 1, role: "primary" as const },
  ],
  style_references: { emulate: [], avoid: [] },
  success_metrics: { primary: "engagement" as const, red_lines: [] },
  asset_pool_id: "liu",
};

const campaign = {
  id: "q2",
  persona_id: "liu",
  goal: "",
  timeline: { start: "2026-04-01T00:00:00Z" },
  key_messages: [],
  content_mix: {},
  overrides: {},
  success_criteria: "",
};

const piece = {
  id: "piece1",
  campaign_id: "q2",
  persona_id: "liu",
  input: {
    raw_materials: [{ id: "rm1", kind: "text" as const, content: "stuff", origin: "inline" }],
    intent: "ship",
  },
  state: "draft" as const,
  platform_variants: [],
  eval_history: [],
};

describe("socialDomain.initState", () => {
  const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });

  it("rejects input missing persona", () => {
    expect(() => domain.initState({ campaign, piece })).toThrow();
  });

  it("rejects input where persona is not an object", () => {
    expect(() => domain.initState({ persona: "not-a-persona", campaign, piece })).toThrow();
  });

  it("rejects piece with unknown variant status (schema enum breach)", () => {
    const badPiece = {
      ...piece,
      platform_variants: [
        {
          platform: "twitter",
          content: "",
          constraints_applied: [],
          inspired_by: [],
          style_patterns_applied: [],
          status: "WAT",
          revision_count: 0,
        },
      ],
    };
    expect(() => domain.initState({ persona, campaign, piece: badPiece })).toThrow();
  });

  it("accepts a fully valid input fixture", () => {
    expect(() => domain.initState({ persona, campaign, piece })).not.toThrow();
  });
});
