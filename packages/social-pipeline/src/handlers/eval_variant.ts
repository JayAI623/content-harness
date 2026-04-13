import type { Delta, InfraBundle, Task, TaskHandler } from "@content-harness/core";
import { aggregate } from "../eval/aggregator.js";
import { simulateAudience } from "../eval/simulator.js";
import { DEFAULT_EVALUATOR_PERSONAS } from "../eval/personas.js";
import type { EvalRound, EvaluatorPersona, SocialAssetRef } from "../schemas/index.js";
import type { SocialState } from "../state.js";

const DEFAULT_THRESHOLDS = { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 };

export const evalVariantHandler: TaskHandler<SocialState> = async (
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
      error: { message: `no variant at (${platform}, ${variantIdx})`, retryable: false },
    };
  }

  // Resolve evaluator personas via AssetRefs in task.input_refs. Fall back to defaults
  // if the asset pool does not yet contain them (bootstrap case).
  const personaRefs: SocialAssetRef[] = task.input_refs.filter(
    (r): r is SocialAssetRef => r.kind === "evaluator_persona",
  );
  const resolvedPersonas: EvaluatorPersona[] = [];
  for (const ref of personaRefs) {
    const p = await infra.assets.resolve<EvaluatorPersona>(state.persona.asset_pool_id, ref);
    if (p) resolvedPersonas.push(p);
  }
  const personas = resolvedPersonas.length > 0 ? resolvedPersonas : DEFAULT_EVALUATOR_PERSONAS;

  const { feedback, cost } = await simulateAudience(infra.llm, {
    variant_text: variant.content,
    personas,
    platform,
  });

  const round = state.piece.eval_history.length;
  const target = {
    kind: "platform_variant" as const,
    piece_id: state.piece.id,
    platform,
    variant_idx: variantIdx,
  };
  const agg = aggregate(feedback, DEFAULT_THRESHOLDS, target);

  const evalRound: EvalRound = {
    round,
    target,
    audience_feedback: feedback,
    aggregated_score: agg.aggregated_score,
    actionable_feedback: agg.actionable_feedback,
    verdict: agg.verdict,
  };

  const variantIdxInArray = state.piece.platform_variants.findIndex((v, i) => v.platform === platform && i === variantIdx);

  return {
    kind: "success",
    patches: [
      { op: "append", path: ["piece", "eval_history"], value: evalRound },
      {
        op: "set",
        path: ["piece", "platform_variants", String(variantIdxInArray), "status"],
        value: agg.verdict === "accept" ? "accepted" : "rejected",
      },
      {
        op: "set",
        path: ["piece", "platform_variants", String(variantIdxInArray), "eval_score"],
        value: agg.aggregated_score,
      },
    ],
    cost,
    result_ref: { kind: "eval_round", piece_id: state.piece.id, round },
  };
};
