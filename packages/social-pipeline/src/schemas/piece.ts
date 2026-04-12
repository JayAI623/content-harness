import { z } from "zod";

export const AssetRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reference_post"),    id: z.string() }),
  z.object({ kind: z.literal("style_pattern"),     id: z.string() }),
  z.object({ kind: z.literal("hot_topic"),         platform: z.string(), topic: z.string() }),
  z.object({ kind: z.literal("evaluator_persona"), id: z.string() }),
  z.object({ kind: z.literal("own_post"),          piece_id: z.string(), platform: z.string() }),
  z.object({ kind: z.literal("voice_fingerprint") }),
]);

export const StateRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("raw_material"),     piece_id: z.string(), material_id: z.string() }),
  z.object({ kind: z.literal("base_article"),     piece_id: z.string() }),
  z.object({ kind: z.literal("platform_variant"), piece_id: z.string(), platform: z.string(), variant_idx: z.number() }),
  z.object({ kind: z.literal("eval_round"),       piece_id: z.string(), round: z.number() }),
  z.object({ kind: z.literal("deliverable"),      path: z.string() }),
]);

export const RawMaterialSchema = z.object({
  id: z.string(),
  kind: z.enum(["text", "url", "file", "note"]),
  content: z.string(),
  origin: z.string(),
});

export const PlatformVariantSchema = z.object({
  platform: z.string(),
  content: z.string(),
  constraints_applied: z.array(z.string()),
  inspired_by: z.array(AssetRefSchema),
  style_patterns_applied: z.array(AssetRefSchema),
  status: z.enum(["drafting", "pending_eval", "accepted", "rejected"]),
  eval_score: z.number().optional(),
  revision_count: z.number(),
});

export const AudienceFeedbackSchema = z.object({
  from: AssetRefSchema,
  understood: z.boolean(),
  engagement_likelihood: z.number(),
  ai_smell_score: z.number(),
  depth_score: z.number(),
  comments: z.string(),
});

export const ActionableFeedbackSchema = z.object({
  from: AssetRefSchema,
  category: z.enum(["tone", "structure", "clarity", "depth", "ai_smell", "other"]),
  text: z.string(),
  targets: z.array(StateRefSchema),
  suggested_refs: z.array(AssetRefSchema).optional(),
});

export const EvalRoundSchema = z.object({
  round: z.number(),
  target: StateRefSchema,
  audience_feedback: z.array(AudienceFeedbackSchema),
  aggregated_score: z.number(),
  actionable_feedback: z.array(ActionableFeedbackSchema),
  verdict: z.enum(["accept", "revise", "abort"]),
});

export const PieceSchema = z.object({
  id: z.string(),
  campaign_id: z.string(),
  persona_id: z.string(),
  input: z.object({
    raw_materials: z.array(RawMaterialSchema),
    intent: z.string(),
  }),
  state: z.enum(["draft", "refining", "evaluating", "ready", "published"]),
  base_article: z.object({
    markdown: z.string(),
    produced_at: z.string(),
    source_refs: z.array(AssetRefSchema),
  }).optional(),
  platform_variants: z.array(PlatformVariantSchema),
  eval_history: z.array(EvalRoundSchema),
});

export type AssetRef = z.infer<typeof AssetRefSchema>;
export type StateRef = z.infer<typeof StateRefSchema>;
export type RawMaterial = z.infer<typeof RawMaterialSchema>;
export type PlatformVariant = z.infer<typeof PlatformVariantSchema>;
export type AudienceFeedback = z.infer<typeof AudienceFeedbackSchema>;
export type ActionableFeedback = z.infer<typeof ActionableFeedbackSchema>;
export type EvalRound = z.infer<typeof EvalRoundSchema>;
export type Piece = z.infer<typeof PieceSchema>;
