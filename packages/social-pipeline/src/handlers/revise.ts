import type { Delta, InfraBundle, Task, TaskHandler } from "@content-harness/core";
import { buildPersonaSystemBlock } from "../prompts/persona.js";
import type { PlatformVariant } from "../schemas/index.js";
import type { SocialState } from "../state.js";

export const reviseHandler: TaskHandler<SocialState> = async (
  task: Task<string>,
  state: SocialState,
  infra: InfraBundle,
): Promise<Delta<SocialState>> => {
  const platform = String(task.params.platform ?? "twitter");
  const variantIdx = Number(task.params.variant_idx ?? 0);
  const variant = state.piece.platform_variants.find((v, i) => v.platform === platform && i === variantIdx);
  if (!variant) {
    return {
      kind: "failure",
      patches: [],
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      error: { message: `no variant at (${platform}, ${variantIdx}) to revise`, retryable: false },
    };
  }

  // Find latest eval round for this variant
  const rounds = state.piece.eval_history.filter((r) =>
    r.target.kind === "platform_variant"
    && r.target.platform === platform
    && r.target.variant_idx === variantIdx,
  );
  const latest = rounds[rounds.length - 1];
  const feedbackBlock = latest?.actionable_feedback
    .map((a) => `- [${a.category}] ${a.text}`)
    .join("\n") || "(no feedback; rewrite for clarity)";

  const persona = state.persona;

  const staticSystem = buildPersonaSystemBlock(persona, { platform });

  const turnSystem = [
    `Task: REVISE the existing variant. Address every piece of actionable feedback below.`,
    `Keep the structure unless feedback explicitly says to rewrite the hook/format.`,
    `Return only the revised variant text.`,
  ].join("\n");

  const userContent = `Previous variant:\n\n${variant.content}\n\nActionable feedback:\n${feedbackBlock}\n\nBase article for reference:\n${state.piece.base_article?.markdown ?? "(missing)"}`;

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

  const nextVariant: PlatformVariant = {
    platform,
    content: result.text,
    constraints_applied: variant.constraints_applied,
    inspired_by: variant.inspired_by,
    style_patterns_applied: variant.style_patterns_applied,
    status: "pending_eval",
    revision_count: variant.revision_count + 1,
  };

  const newVariantIdx = state.piece.platform_variants.length;

  return {
    kind: "success",
    patches: [
      { op: "append", path: ["piece", "platform_variants"], value: nextVariant },
    ],
    cost: result.cost,
    result_ref: { kind: "platform_variant", piece_id: state.piece.id, platform, variant_idx: newVariantIdx },
  };
};
