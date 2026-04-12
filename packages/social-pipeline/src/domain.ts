import type {
  AssetRef,
  HarnessDomain,
  PlanContext,
  Task,
  TaskHandler,
  Verdict,
  WorkPlan,
} from "@content-harness/core";
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

  const evaluatorRefs: AssetRef[] = state.persona.audience.evaluator_persona_ids.map((id) => ({
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
      // v1 replan is identical to planInitial — later versions can shrink/expand based on state
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
          const round = [...state.piece.eval_history]
            .reverse()
            .find((r) => r.target.kind === "platform_variant" && r.target.platform === variant.platform);
          const feedback = round?.actionable_feedback.map((a) => `[${a.category}] ${a.text}`).join(" | ") ?? "tighten the draft";
          if (variant.revision_count >= 3) {
            return { kind: "redirect", reason: `variant for ${variant.platform} failed after max revisions` };
          }
          return { kind: "revise", task_id: `refine_variant-for-${variant.platform}`, feedback };
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
