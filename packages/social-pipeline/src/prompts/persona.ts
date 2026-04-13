import type { Persona } from "../schemas/index.js";

export interface PersonaBlockOpts {
  platform?: string;
}

/**
 * Build the static persona system block shared by draft_base, refine_variant,
 * and revise. Keep the wording identical to what draft_base used pre-extraction
 * — draft_base's handler test asserts on a lowercase "avoid" substring, so the
 * prefer/avoid lines are deliberately lowercase here.
 */
export function buildPersonaSystemBlock(
  persona: Persona,
  opts: PersonaBlockOpts = {},
): string {
  const where = opts.platform ? ` on ${opts.platform}` : "";
  return [
    `You are ghostwriting for ${persona.identity.name}${where}.`,
    `Voice: tone=${persona.voice.tone}. POV=${persona.voice.point_of_view}.`,
    `prefer words: ${persona.voice.vocabulary.prefer.join(", ") || "(none)"}`,
    `avoid words: ${persona.voice.vocabulary.avoid.join(", ") || "(none)"}`,
  ].join("\n");
}
