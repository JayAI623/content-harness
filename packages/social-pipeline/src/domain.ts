import type {
  HarnessDomain,
  PlanContext,
  Task,
  TaskHandler,
  Verdict,
  WorkPlan,
} from "@content-harness/core";
import { z } from "zod";
import { makeResearchRefsHandler } from "./handlers/research_refs.js";
import { draftBaseHandler } from "./handlers/draft_base.js";
import { refineVariantHandler } from "./handlers/refine_variant.js";
import { evalVariantHandler } from "./handlers/eval_variant.js";
import { reviseHandler } from "./handlers/revise.js";
import type { OpencliClient } from "./opencli-client.js";
import {
  PersonaSchema,
  CampaignSchema,
  PieceSchema,
  type PlatformVariant,
  type SocialAssetRef,
} from "./schemas/index.js";
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

interface IdGen {
  next(prefix: string): string;
}

function makeIdGen(): IdGen {
  let counter = 0;
  return { next: (prefix: string) => `${prefix}-${++counter}` };
}

interface LatestVariantEntry {
  idx: number;
  variant: PlatformVariant;
}

/**
 * Build a map from platform → {idx, variant} containing the LATEST variant
 * for each platform. Since revise appends new variants at the end of
 * platform_variants, iterating in order and overwriting gives us the latest.
 */
function getLatestVariantPerPlatform(state: SocialState): Map<string, LatestVariantEntry> {
  const map = new Map<string, LatestVariantEntry>();
  state.piece.platform_variants.forEach((variant, idx) => {
    map.set(variant.platform, { idx, variant });
  });
  return map;
}

/**
 * Scan the latest variant per platform. Returns the first one that is
 * rejected AND still has revision budget. Used by replan() to decide whether
 * to build a focused revise plan.
 */
function findLatestRejectedNeedingRevision(
  state: SocialState,
  maxRevisions: number,
): LatestVariantEntry | null {
  for (const entry of getLatestVariantPerPlatform(state).values()) {
    if (entry.variant.status === "rejected" && entry.variant.revision_count < maxRevisions) {
      return entry;
    }
  }
  return null;
}

function buildInitialPlan(state: SocialState, ids: IdGen): WorkPlan<SocialTaskKind> {
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
    id: ids.next("research_refs"),
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
    id: ids.next("draft_base"),
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
    id: ids.next("refine_variant"),
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
    id: ids.next("eval_variant"),
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

function buildRevisePlan(
  state: SocialState,
  rejectedIdx: number,
  ids: IdGen,
): WorkPlan<SocialTaskKind> {
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
    id: ids.next("revise"),
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
    id: ids.next("eval_variant"),
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
  // One IdGen per domain instance — scoped to a single run so task IDs never
  // collide with entries already written to events.jsonl.
  const ids = makeIdGen();

  return {
    async planInitial(ctx: PlanContext<SocialState>): Promise<WorkPlan<SocialTaskKind>> {
      return buildInitialPlan(ctx.state, ids);
    },

    async replan(ctx: PlanContext<SocialState>, _reason: string): Promise<WorkPlan<SocialTaskKind>> {
      // If the latest variant for any platform is rejected and still has
      // revision budget, build a focused revise+eval_variant plan. Otherwise
      // fall back to a full initial plan.
      const rejected = findLatestRejectedNeedingRevision(ctx.state, ctx.config.max_revisions);
      if (rejected) {
        return buildRevisePlan(ctx.state, rejected.idx, ids);
      }
      return buildInitialPlan(ctx.state, ids);
    },

    handlers,

    async evaluate(ctx: PlanContext<SocialState>): Promise<Verdict> {
      const state = ctx.state;
      const maxRevisions = ctx.config.max_revisions;
      const variants = state.piece.platform_variants;
      if (variants.length === 0) return { kind: "continue" };

      let allAccepted = true;
      for (const { variant } of getLatestVariantPerPlatform(state).values()) {
        if (variant.status === "accepted") continue;
        if (variant.status === "rejected") {
          if (variant.revision_count >= maxRevisions) {
            return {
              kind: "abort",
              reason: `variant for ${variant.platform} failed after ${maxRevisions} revisions`,
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
      return Array.from(getLatestVariantPerPlatform(state).values()).every(
        ({ variant }) => variant.status === "accepted",
      );
    },

    initState(input: unknown): SocialState {
      const parsed = z
        .object({
          persona: PersonaSchema,
          campaign: CampaignSchema,
          piece: PieceSchema,
        })
        .parse(input);
      return initSocialState(parsed);
    },

    serializeState(state: SocialState): object {
      return state as unknown as object;
    },

    deserializeState(obj: object): SocialState {
      return obj as SocialState;
    },
  };
}
