import type {
  HarnessDomain,
  PlanContext,
  Task,
  TaskHandler,
  Verdict,
  WorkPlan,
} from "@content-harness/core";
import type { SocialAssetRef } from "./refs.js";
import { makeResearchRefsHandler } from "./handlers/research_refs.js";
import { draftBaseHandler } from "./handlers/draft_base.js";
import { refineVariantHandler } from "./handlers/refine_variant.js";
import { evalVariantHandler } from "./handlers/eval_variant.js";
import { reviseHandler } from "./handlers/revise.js";
import type { OpencliClient } from "./opencli-client.js";
import type { Persona, Campaign, Piece } from "./schemas/index.js";
import { initSocialState, type SocialState } from "./state.js";

export type SocialTaskKind =
  | "research_refs"
  | "draft_base"
  | "refine_variant"
  | "eval_variant"
  | "revise";

export interface SocialDomainDeps {
  opencli: OpencliClient;
}

const MAX_REVISIONS = 3;

let taskCounter = 0;
const nextId = (prefix: string): string => `${prefix}-${++taskCounter}`;

function buildInitialPlan(state: SocialState): WorkPlan<SocialTaskKind> {
  taskCounter = 0;
  const piece = state.piece;
  const primaryPlatforms = state.persona.platforms
    .filter((p) => p.priority > 0 && p.role !== "syndicate")
    .map((p) => p.platform);
  // v1: twitter-only
  const platform: string = primaryPlatforms.includes("twitter") ? "twitter" : primaryPlatforms[0] ?? "twitter";

  const evaluatorRefs: SocialAssetRef[] = state.persona.audience.evaluator_persona_ids.map((id) => ({
    kind: "evaluator_persona",
    id,
  }));

  const research: Task<SocialTaskKind> = {
    id: nextId("research_refs"),
    kind: "research_refs",
    params: { platform, query: piece.input.intent, limit: 15 },
    deps: [],
    input_refs: [],
    acceptance_criteria: `reference_posts added for ${platform}`,
    gate_before: false,
    gate_after: false,
    status: "pending",
  };

  const draft: Task<SocialTaskKind> = {
    id: nextId("draft_base"),
    kind: "draft_base",
    params: {},
    deps: [research.id],
    input_refs: [],
    acceptance_criteria: "base_article written",
    gate_before: false,
    gate_after: false,
    status: "pending",
  };

  const refine: Task<SocialTaskKind> = {
    id: nextId("refine_variant"),
    kind: "refine_variant",
    params: { platform },
    deps: [draft.id],
    input_refs: [],
    acceptance_criteria: `${platform} variant produced`,
    gate_before: false,
    gate_after: true,
    status: "pending",
  };

  const evalTask: Task<SocialTaskKind> = {
    id: nextId("eval_variant"),
    kind: "eval_variant",
    params: { platform, variant_idx: 0 },
    deps: [refine.id],
    input_refs: evaluatorRefs,
    acceptance_criteria: `variant scores >= thresholds`,
    gate_before: false,
    gate_after: false,
    status: "pending",
  };

  return {
    plan_id: `plan-${piece.id}-${Date.now()}`,
    piece_id: piece.id,
    tasks: [research, draft, refine, evalTask],
    budget_estimate: { tokens: 50_000, usd: 0.5, iterations: 6 },
  };
}

function buildRevisePlan(state: SocialState, rejectedIdx: number): WorkPlan<SocialTaskKind> {
  // Intentionally do NOT reset taskCounter — replan reuses the counter so IDs remain unique.
  const variant = state.piece.platform_variants[rejectedIdx]!;
  const platform = variant.platform;
  // The revise handler appends the revised variant at the END of platform_variants,
  // so its index in the resulting array will be the current length.
  const newVariantIdx = state.piece.platform_variants.length;

  const evaluatorRefs: SocialAssetRef[] = state.persona.audience.evaluator_persona_ids.map((id) => ({
    kind: "evaluator_persona",
    id,
  }));

  const reviseTask: Task<SocialTaskKind> = {
    id: nextId("revise"),
    kind: "revise",
    params: { platform, variant_idx: rejectedIdx },
    deps: [],
    input_refs: [],
    acceptance_criteria: `${platform} variant revised`,
    gate_before: false,
    gate_after: false,
    status: "pending",
  };

  const evalTask: Task<SocialTaskKind> = {
    id: nextId("eval_variant"),
    kind: "eval_variant",
    params: { platform, variant_idx: newVariantIdx },
    deps: [reviseTask.id],
    input_refs: evaluatorRefs,
    acceptance_criteria: `variant scores >= thresholds`,
    gate_before: false,
    gate_after: false,
    status: "pending",
  };

  return {
    plan_id: `plan-${state.piece.id}-revise-${Date.now()}`,
    piece_id: state.piece.id,
    tasks: [reviseTask, evalTask],
    budget_estimate: { tokens: 20_000, usd: 0.2, iterations: 2 },
  };
}

export function makeSocialDomain(deps: SocialDomainDeps): HarnessDomain<SocialTaskKind, SocialState> {
  const researchRefs = makeResearchRefsHandler({ opencli: deps.opencli });
  const handlers: Record<SocialTaskKind, TaskHandler<SocialState>> = {
    research_refs: researchRefs,
    draft_base: draftBaseHandler,
    refine_variant: refineVariantHandler,
    eval_variant: evalVariantHandler,
    revise: reviseHandler,
  };

  return {
    async planInitial(ctx: PlanContext<SocialState>): Promise<WorkPlan<SocialTaskKind>> {
      return buildInitialPlan(ctx.state);
    },

    async replan(ctx: PlanContext<SocialState>, _reason: string): Promise<WorkPlan<SocialTaskKind>> {
      // If there is a recent rejected variant that still has revision budget, build
      // a focused revise+eval_variant plan instead of starting from scratch.
      const variants = ctx.state.piece.platform_variants;
      for (let i = variants.length - 1; i >= 0; i--) {
        const v = variants[i]!;
        if (v.status === "rejected" && v.revision_count < MAX_REVISIONS) {
          return buildRevisePlan(ctx.state, i);
        }
      }
      return buildInitialPlan(ctx.state);
    },

    handlers,

    async evaluate(state: SocialState): Promise<Verdict> {
      const variants = state.piece.platform_variants;
      if (variants.length === 0) return { kind: "continue" };

      const latestByPlatform = new Map<string, (typeof variants)[number]>();
      variants.forEach((v) => latestByPlatform.set(v.platform, v));

      let allAccepted = true;
      for (const variant of latestByPlatform.values()) {
        if (variant.status === "accepted") continue;
        if (variant.status === "rejected") {
          if (variant.revision_count >= MAX_REVISIONS) {
            return {
              kind: "abort",
              reason: `variant for ${variant.platform} failed after ${MAX_REVISIONS} revisions`,
            };
          }
          return { kind: "redirect", reason: `revise ${variant.platform} variant` };
        }
        allAccepted = false;
      }
      return allAccepted ? { kind: "done" } : { kind: "continue" };
    },

    isDone(state: SocialState): boolean {
      const variants = state.piece.platform_variants;
      if (variants.length === 0) return false;
      const latestByPlatform = new Map<string, (typeof variants)[number]>();
      variants.forEach((v) => latestByPlatform.set(v.platform, v));
      return Array.from(latestByPlatform.values()).every((v) => v.status === "accepted");
    },

    initState(input: unknown): SocialState {
      const { persona, campaign, piece } = input as { persona: Persona; campaign: Campaign; piece: Piece };
      return initSocialState({ persona, campaign, piece });
    },

    serializeState(state: SocialState): object {
      return state as unknown as object;
    },

    deserializeState(obj: object): SocialState {
      return obj as SocialState;
    },
  };
}
