import type { Delta, InfraBundle, Task, TaskHandler } from "@content-harness/core";
import type { PlatformVariant } from "../schemas/index.js";
import type { SocialState } from "../state.js";

const TWITTER_CONSTRAINTS = [
  "Target: a thread of 3–7 tweets",
  "Each tweet ≤ 280 characters",
  "Number tweets like '1/', '2/', ..., '7/'",
  "Hook on tweet 1 must stand alone (someone could quote it)",
  "Max 2 hashtags total across the thread, preferably none",
  "No emojis unless Persona example_phrases include them",
];

const PLATFORM_CONSTRAINTS: Record<string, string[]> = {
  twitter: TWITTER_CONSTRAINTS,
};

export const refineVariantHandler: TaskHandler<SocialState> = async (
  task: Task<string>,
  state: SocialState,
  infra: InfraBundle,
): Promise<Delta<SocialState>> => {
  const platform = String(task.params.platform ?? "twitter");
  if (!state.piece.base_article) {
    return {
      kind: "failure",
      patches: [],
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      error: { message: "refine_variant needs base_article in state", retryable: false },
    };
  }
  const constraints = PLATFORM_CONSTRAINTS[platform] ?? [];
  if (constraints.length === 0) {
    return {
      kind: "failure",
      patches: [],
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      error: { message: `no constraints defined for platform ${platform}`, retryable: false },
    };
  }

  const persona = state.persona;
  const variantIdx = state.piece.platform_variants.filter((v) => v.platform === platform).length;

  const staticSystem = [
    `You are ghostwriting for ${persona.identity.name} on ${platform}.`,
    `Voice: tone=${persona.voice.tone}. POV=${persona.voice.point_of_view}.`,
    `Prefer words: ${persona.voice.vocabulary.prefer.join(", ") || "(none)"}`,
    `Avoid words: ${persona.voice.vocabulary.avoid.join(", ") || "(none)"}`,
    `Example phrases: ${persona.voice.example_phrases.join(" / ")}`,
    `Red lines: ${persona.success_metrics.red_lines.join("; ") || "(none)"}`,
  ].join("\n");

  const turnSystem = [
    `Task: convert the BASE ARTICLE into a platform-native variant for ${platform}.`,
    ...constraints.map((c) => `- ${c}`),
    `Return ONLY the variant text, no preface.`,
  ].join("\n");

  const userContent = `Base article (markdown):\n\n${state.piece.base_article.markdown}`;

  const result = await infra.llm.complete({
    tier: "main",
    system: [
      { text: staticSystem, cache: true },
      { text: turnSystem, cache: false },
    ],
    messages: [{ role: "user", content: userContent }],
    max_tokens: 1500,
    temperature: 0.55,
  });

  const variant: PlatformVariant = {
    platform,
    content: result.text,
    constraints_applied: constraints,
    inspired_by: [],
    style_patterns_applied: [],
    status: "pending_eval",
    revision_count: 0,
  };

  return {
    kind: "success",
    patches: [
      { op: "append", path: ["piece", "platform_variants"], value: variant },
    ],
    cost: result.cost,
    result_ref: {
      kind: "platform_variant",
      piece_id: state.piece.id,
      platform,
      variant_idx: variantIdx,
    },
  };
};
