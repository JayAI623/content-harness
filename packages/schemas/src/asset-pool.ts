import { z } from "zod";

export const ReferencePostSchema = z.object({
  id: z.string(),
  platform: z.string(),
  author: z.string(),
  url: z.string(),
  content: z.string(),
  engagement: z.object({
    likes: z.number().optional(),
    shares: z.number().optional(),
    comments: z.number().optional(),
    views: z.number().optional(),
  }),
  topic_tags: z.array(z.string()),
  collected_at: z.string(),
  expires_at: z.string().optional(),
  source_query: z.string(),
});

export const StylePatternSchema = z.object({
  id: z.string(),
  platform: z.string(),
  pattern_type: z.enum(["opening", "transition", "cta", "tone", "structure", "vocab", "emoji_use", "hashtag_use"]),
  pattern_text: z.string(),
  example_ref_ids: z.array(z.string()),
  extracted_at: z.string(),
});

export const HotTopicSchema = z.object({
  platform: z.string(),
  topic: z.string(),
  score: z.number(),
  observed_window: z.object({ from: z.string(), to: z.string() }),
  expires_at: z.string(),
  source: z.string(),
});

export const EvaluatorPersonaSchema = z.object({
  id: z.string(),
  name: z.string(),
  background: z.string(),
  interests: z.array(z.string()),
  pain_points: z.array(z.string()),
  reading_goals: z.array(z.string()),
  critic_style: z.enum(["strict", "balanced", "generous"]),
  language: z.enum(["en", "zh", "other"]),
});

export const OwnPostSchema = z.object({
  piece_id: z.string(),
  platform: z.string(),
  url: z.string().optional(),
  metrics: z.record(z.number()),
  posted_at: z.string(),
});

export const VoiceFingerprintSchema = z.object({
  vocab_histogram: z.record(z.number()),
  sentence_rhythms: z.string(),
  typical_openings: z.array(z.string()),
  quirks: z.array(z.string()),
  extracted_from_piece_ids: z.array(z.string()),
  updated_at: z.string(),
});

export const AssetPoolSchema = z.object({
  persona_id: z.string(),
  reference_posts: z.array(ReferencePostSchema),
  style_patterns: z.array(StylePatternSchema),
  hot_topics: z.array(HotTopicSchema),
  evaluator_personas: z.array(EvaluatorPersonaSchema),
  own_history: z.array(OwnPostSchema),
  voice_fingerprint: VoiceFingerprintSchema.optional(),
});

export type ReferencePost = z.infer<typeof ReferencePostSchema>;
export type StylePattern = z.infer<typeof StylePatternSchema>;
export type HotTopic = z.infer<typeof HotTopicSchema>;
export type EvaluatorPersona = z.infer<typeof EvaluatorPersonaSchema>;
export type OwnPost = z.infer<typeof OwnPostSchema>;
export type VoiceFingerprint = z.infer<typeof VoiceFingerprintSchema>;
export type AssetPool = z.infer<typeof AssetPoolSchema>;
