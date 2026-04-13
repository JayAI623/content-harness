import { describe, it, expect } from "vitest";
import { makeSocialDomain } from "../src/domain.js";
import { fakeOpencliClient } from "../src/opencli-client.js";
import { DEFAULT_EVALUATOR_PERSONAS } from "../src/eval/personas.js";

const persona = {
  id: "liu",
  identity: { name: "Liu", one_line_bio: "", long_bio: "" },
  voice: { tone: "analytic", point_of_view: "first-person", vocabulary: { prefer: [], avoid: [] }, example_phrases: [] },
  domain: { primary_topics: ["ai"], expertise_depth: "practitioner" as const, adjacent_topics: [] },
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

const campaign = { id: "q2", persona_id: "liu", goal: "", timeline: { start: "2026-04-01T00:00:00Z" }, key_messages: [], content_mix: {}, overrides: {}, success_criteria: "" };
const piece = {
  id: "piece1",
  campaign_id: "q2",
  persona_id: "liu",
  input: { raw_materials: [{ id: "rm1", kind: "text" as const, content: "stuff", origin: "inline" }], intent: "ship" },
  state: "draft" as const,
  platform_variants: [],
  eval_history: [],
};

const stubConfig = {
  run_id: "r", run_root: "/tmp",
  budget: { max_iterations: 100 },
  retry: { max_attempts: 2, backoff_ms: 0 },
  gates: { post_plan: false, pre_publish: false },
  gate_resolver: async () => "approve" as const,
  thresholds: { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 },
  max_revisions: 3,
};

describe("social domain", () => {
  it("initState builds SocialState from input object", () => {
    const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });
    const state = domain.initState({ persona, campaign, piece });
    expect((state as any).persona.id).toBe("liu");
    expect((state as any).piece.id).toBe("piece1");
  });

  it("planInitial emits research_refs, draft_base, refine_variant, eval_variant in dep order", async () => {
    const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });
    const state = domain.initState({ persona, campaign, piece });
    const plan = await domain.planInitial({ state, config: stubConfig as any });
    const kinds = plan.tasks.map((t) => t.kind);
    expect(kinds).toContain("research_refs");
    expect(kinds).toContain("draft_base");
    expect(kinds).toContain("refine_variant");
    expect(kinds).toContain("eval_variant");
    const draft = plan.tasks.find((t) => t.kind === "draft_base")!;
    const research = plan.tasks.find((t) => t.kind === "research_refs")!;
    expect(draft.deps).toContain(research.id);
  });

  it("refine_variant task has gate_after true", async () => {
    const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });
    const state = domain.initState({ persona, campaign, piece });
    const plan = await domain.planInitial({ state, config: stubConfig as any });
    const refine = plan.tasks.find((t) => t.kind === "refine_variant")!;
    expect(refine.gate_after).toBe(true);
  });

  it("evaluate returns done when all platform variants are accepted", async () => {
    const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });
    const acceptedPiece = {
      ...piece,
      platform_variants: [{
        platform: "twitter",
        content: "x",
        constraints_applied: [],
        inspired_by: [],
        style_patterns_applied: [],
        status: "accepted" as const,
        revision_count: 0,
      }],
    };
    const state = domain.initState({ persona, campaign, piece: acceptedPiece });
    const verdict = await domain.evaluate(state);
    expect(verdict.kind).toBe("done");
  });

  it("evaluate returns redirect when a variant was rejected and max_revisions not hit", async () => {
    const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });
    const rejectedPiece = {
      ...piece,
      platform_variants: [{
        platform: "twitter",
        content: "x",
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
        aggregated_score: 0.5,
        actionable_feedback: [],
        verdict: "revise" as const,
      }],
    };
    const state = domain.initState({ persona, campaign, piece: rejectedPiece });
    const verdict = await domain.evaluate(state);
    expect(verdict.kind).toBe("redirect");
  });

  it("evaluate returns abort when variant was rejected after max revisions", async () => {
    const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });
    const rejectedPiece = {
      ...piece,
      platform_variants: [{
        platform: "twitter",
        content: "x",
        constraints_applied: [],
        inspired_by: [],
        style_patterns_applied: [],
        status: "rejected" as const,
        revision_count: 3,
      }],
      eval_history: [{
        round: 0,
        target: { kind: "platform_variant" as const, piece_id: "piece1", platform: "twitter", variant_idx: 0 },
        audience_feedback: [],
        aggregated_score: 0.5,
        actionable_feedback: [],
        verdict: "revise" as const,
      }],
    };
    const state = domain.initState({ persona, campaign, piece: rejectedPiece });
    const verdict = await domain.evaluate(state);
    expect(verdict.kind).toBe("abort");
    if (verdict.kind === "abort") {
      expect(typeof verdict.reason).toBe("string");
      expect(verdict.reason.length).toBeGreaterThan(0);
    }
  });

  it("replan builds revise+eval_variant tasks when a variant is rejected", async () => {
    const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });
    const rejectedPiece = {
      ...piece,
      platform_variants: [{
        platform: "twitter",
        content: "x",
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
        aggregated_score: 0.5,
        actionable_feedback: [],
        verdict: "revise" as const,
      }],
    };
    const state = domain.initState({ persona, campaign, piece: rejectedPiece });
    const plan = await domain.replan({ state, config: stubConfig as any }, "test");
    expect(plan.tasks.length).toBe(2);
    expect(plan.tasks[0]!.kind).toBe("revise");
    expect(plan.tasks[0]!.params.variant_idx).toBe(0);
    expect(plan.tasks[0]!.params.platform).toBe("twitter");
    expect(plan.tasks[1]!.kind).toBe("eval_variant");
    expect(plan.tasks[1]!.params.variant_idx).toBe(1);
    expect(plan.tasks[1]!.params.platform).toBe("twitter");
    expect(plan.tasks[1]!.deps).toContain(plan.tasks[0]!.id);
  });

  it("replan falls back to full initial plan when no rejected variant needs revision", async () => {
    const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });
    const acceptedPiece = {
      ...piece,
      platform_variants: [{
        platform: "twitter",
        content: "x",
        constraints_applied: [],
        inspired_by: [],
        style_patterns_applied: [],
        status: "accepted" as const,
        revision_count: 0,
      }],
    };
    const state = domain.initState({ persona, campaign, piece: acceptedPiece });
    const plan = await domain.replan({ state, config: stubConfig as any }, "test");
    expect(plan.tasks.length).toBe(4);
  });

  it("replan respects ctx.config.max_revisions", async () => {
    const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });
    const rejectedPiece = {
      ...piece,
      platform_variants: [{
        platform: "twitter",
        content: "x",
        constraints_applied: [],
        inspired_by: [],
        style_patterns_applied: [],
        status: "rejected" as const,
        revision_count: 1,
      }],
      eval_history: [{
        round: 0,
        target: { kind: "platform_variant" as const, piece_id: "piece1", platform: "twitter", variant_idx: 0 },
        audience_feedback: [],
        aggregated_score: 0.5,
        actionable_feedback: [],
        verdict: "revise" as const,
      }],
    };
    const state = domain.initState({ persona, campaign, piece: rejectedPiece });
    // With max_revisions=1 and revision_count=1, replan should fall back to
    // the full initial plan (4 tasks) because the variant has no budget left.
    const lowConfig = { ...stubConfig, max_revisions: 1 };
    const plan = await domain.replan({ state, config: lowConfig as any }, "test");
    expect(plan.tasks.length).toBe(4);
  });

  it("task counter is instance-scoped and does not reset across plan builds", async () => {
    const domain = makeSocialDomain({ opencli: fakeOpencliClient({}) });
    const state = domain.initState({ persona, campaign, piece });
    const plan1 = await domain.planInitial({ state, config: stubConfig as any });
    const plan2 = await domain.planInitial({ state, config: stubConfig as any });
    const allIds = [...plan1.tasks, ...plan2.tasks].map((t) => t.id);
    expect(new Set(allIds).size).toBe(allIds.length); // no collisions
  });
});
