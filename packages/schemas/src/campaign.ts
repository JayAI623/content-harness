import { z } from "zod";

export const CampaignSchema = z.object({
  id: z.string(),
  persona_id: z.string(),
  goal: z.string(),
  timeline: z.object({
    start: z.string(),
    end: z.string().optional(),
  }),
  key_messages: z.array(z.string()),
  content_mix: z.record(z.number()),
  overrides: z.object({
    platform_weights: z.record(z.number()).optional(),
    audience_additions: z.array(z.string()).optional(),
    voice_tweaks: z.record(z.unknown()).optional(),
  }),
  success_criteria: z.string(),
});

export type Campaign = z.infer<typeof CampaignSchema>;
