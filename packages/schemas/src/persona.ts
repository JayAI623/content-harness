import { z } from "zod";

export const PlatformEnum = z.enum(["twitter", "linkedin", "medium", "xiaohongshu"]);

export const PlatformBindingSchema = z.object({
  platform: PlatformEnum,
  handle: z.string(),
  priority: z.number().min(0).max(1),
  role: z.enum(["primary", "cross-post", "syndicate"]),
});

export const AccountRefSchema = z.object({
  platform: PlatformEnum,
  handle: z.string(),
  why: z.string(),
});

export const PersonaSchema = z.object({
  id: z.string(),
  identity: z.object({
    name: z.string(),
    one_line_bio: z.string(),
    long_bio: z.string(),
  }),
  voice: z.object({
    tone: z.string(),
    point_of_view: z.string(),
    vocabulary: z.object({ prefer: z.array(z.string()), avoid: z.array(z.string()) }),
    example_phrases: z.array(z.string()),
  }),
  domain: z.object({
    primary_topics: z.array(z.string()),
    expertise_depth: z.enum(["beginner", "practitioner", "expert"]),
    adjacent_topics: z.array(z.string()),
  }),
  audience: z.object({
    description: z.string(),
    pain_points: z.array(z.string()),
    sophistication: z.enum(["layperson", "practitioner", "expert"]),
    evaluator_persona_ids: z.array(z.string()),
  }),
  platforms: z.array(PlatformBindingSchema),
  style_references: z.object({
    emulate: z.array(AccountRefSchema),
    avoid: z.array(AccountRefSchema),
  }),
  success_metrics: z.object({
    primary: z.enum(["engagement", "growth", "clicks", "citations"]),
    red_lines: z.array(z.string()),
  }),
  asset_pool_id: z.string(),
});

export type Persona = z.infer<typeof PersonaSchema>;
export type PlatformBinding = z.infer<typeof PlatformBindingSchema>;
