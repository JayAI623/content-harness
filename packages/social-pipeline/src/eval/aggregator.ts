import type { ActionableFeedback, AudienceFeedback, SocialStateRef } from "../schemas/index.js";

export interface EvalThresholds {
  eval_pass: number;
  ai_smell_max: number;
  depth_min: number;
}

export interface AggregateResult {
  aggregated_score: number;
  ai_smell: number;
  depth: number;
  verdict: "accept" | "revise" | "abort";
  actionable_feedback: ActionableFeedback[];
}

export function aggregate(feedback: AudienceFeedback[], thresholds: EvalThresholds, target?: SocialStateRef): AggregateResult {
  if (feedback.length === 0) {
    return {
      aggregated_score: 0,
      ai_smell: 1,
      depth: 0,
      verdict: "abort",
      actionable_feedback: [],
    };
  }
  const aggregated_score = avg(feedback.map((f) => f.engagement_likelihood));
  const ai_smell = Math.max(...feedback.map((f) => f.ai_smell_score));
  const depth = avg(feedback.map((f) => f.depth_score));

  const passed = aggregated_score >= thresholds.eval_pass
              && ai_smell <= thresholds.ai_smell_max
              && depth >= thresholds.depth_min;

  const actionable: ActionableFeedback[] = passed
    ? []
    : feedback
        .filter((f) =>
          f.engagement_likelihood < thresholds.eval_pass
          || f.ai_smell_score > thresholds.ai_smell_max
          || f.depth_score < thresholds.depth_min,
        )
        .map((f) => ({
          from: f.from,
          category: pickCategory(f, thresholds),
          text: f.comments,
          targets: target ? [target] : [],
        }));

  return {
    aggregated_score,
    ai_smell,
    depth,
    verdict: passed ? "accept" : "revise",
    actionable_feedback: actionable,
  };
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pickCategory(f: AudienceFeedback, t: EvalThresholds): ActionableFeedback["category"] {
  if (f.ai_smell_score > t.ai_smell_max) return "ai_smell";
  if (f.depth_score < t.depth_min) return "depth";
  if (f.engagement_likelihood < t.eval_pass) return "tone";
  return "other";
}
