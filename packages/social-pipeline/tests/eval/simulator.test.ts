import { describe, it, expect } from "vitest";
import { simulateAudience } from "../../src/eval/simulator.js";
import { fakeLLMClient } from "@content-harness/core";
import { DEFAULT_EVALUATOR_PERSONAS } from "../../src/eval/personas.js";

describe("simulateAudience", () => {
  it("dispatches one LLM call per evaluator persona and parses feedback", async () => {
    const llm = fakeLLMClient([
      {
        text: JSON.stringify({ understood: true, engagement_likelihood: 0.8, ai_smell_score: 0.2, depth_score: 0.7, comments: "c1" }),
        cost: { input_tokens: 10, output_tokens: 20, usd: 0.001 },
        stop_reason: "end_turn",
      },
      {
        text: JSON.stringify({ understood: true, engagement_likelihood: 0.75, ai_smell_score: 0.25, depth_score: 0.6, comments: "c2" }),
        cost: { input_tokens: 10, output_tokens: 20, usd: 0.001 },
        stop_reason: "end_turn",
      },
      {
        text: JSON.stringify({ understood: true, engagement_likelihood: 0.9, ai_smell_score: 0.1, depth_score: 0.8, comments: "c3" }),
        cost: { input_tokens: 10, output_tokens: 20, usd: 0.001 },
        stop_reason: "end_turn",
      },
    ]);
    const feedback = await simulateAudience(llm, {
      variant_text: "hello world",
      personas: DEFAULT_EVALUATOR_PERSONAS,
    });
    expect(feedback).toHaveLength(3);
    expect(feedback[0]!.engagement_likelihood).toBe(0.8);
    expect(feedback.every((f) => f.from.kind === "evaluator_persona")).toBe(true);
  });

  it("handles malformed JSON by marking persona with low scores", async () => {
    const llm = fakeLLMClient([
      {
        text: "not a json",
        cost: { input_tokens: 10, output_tokens: 20, usd: 0.001 },
        stop_reason: "end_turn",
      },
    ]);
    const feedback = await simulateAudience(llm, {
      variant_text: "hi",
      personas: [DEFAULT_EVALUATOR_PERSONAS[0]!],
    });
    expect(feedback).toHaveLength(1);
    expect(feedback[0]!.engagement_likelihood).toBe(0);
    expect(feedback[0]!.ai_smell_score).toBe(1);
  });
});
