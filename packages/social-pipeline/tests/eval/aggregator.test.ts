import { describe, it, expect } from "vitest";
import { aggregate } from "../../src/eval/aggregator.js";
import type { AudienceFeedback } from "../../src/schemas/index.js";

const fb = (engagement: number, aiSmell: number, depth: number, comment = "c"): AudienceFeedback => ({
  from: { kind: "evaluator_persona", id: "p" },
  understood: true,
  engagement_likelihood: engagement,
  ai_smell_score: aiSmell,
  depth_score: depth,
  comments: comment,
});

describe("aggregate", () => {
  it("averages engagement, maxes ai_smell, averages depth", () => {
    const result = aggregate([fb(0.8, 0.1, 0.6), fb(0.6, 0.4, 0.7), fb(0.9, 0.2, 0.5)], {
      eval_pass: 0.7,
      ai_smell_max: 0.3,
      depth_min: 0.5,
    });
    expect(result.aggregated_score).toBeCloseTo((0.8 + 0.6 + 0.9) / 3);
    expect(result.ai_smell).toBeCloseTo(0.4);
    expect(result.depth).toBeCloseTo((0.6 + 0.7 + 0.5) / 3);
  });

  it("marks accept when thresholds clear", () => {
    const result = aggregate([fb(0.9, 0.1, 0.8)], { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 });
    expect(result.verdict).toBe("accept");
  });

  it("marks revise when engagement too low", () => {
    const result = aggregate([fb(0.5, 0.1, 0.8)], { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 });
    expect(result.verdict).toBe("revise");
  });

  it("marks revise when ai_smell too high", () => {
    const result = aggregate([fb(0.9, 0.5, 0.8)], { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 });
    expect(result.verdict).toBe("revise");
  });

  it("marks revise when depth too low", () => {
    const result = aggregate([fb(0.9, 0.1, 0.3)], { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 });
    expect(result.verdict).toBe("revise");
  });

  it("derives actionable_feedback from comments when failing", () => {
    const result = aggregate([fb(0.5, 0.1, 0.8, "feels generic, add a concrete number")], {
      eval_pass: 0.7,
      ai_smell_max: 0.3,
      depth_min: 0.5,
    });
    expect(result.actionable_feedback).toHaveLength(1);
    expect(result.actionable_feedback[0]!.text).toContain("concrete number");
  });
});
