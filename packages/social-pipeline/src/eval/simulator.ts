import type { LLMClient, CostAccounting } from "@content-harness/core";
import type { AudienceFeedback, EvaluatorPersona } from "../schemas/index.js";

interface SimulateOpts {
  variant_text: string;
  personas: EvaluatorPersona[];
  platform?: string;
}

const SYSTEM_TEMPLATE = (p: EvaluatorPersona, platform: string) => `You are ${p.name}. ${p.background}

You are going to read a ${platform} post and rate it honestly as if it landed in your feed. Do NOT be polite. Apply your critic style: ${p.critic_style}.

Return ONLY a single JSON object on one line with exactly these fields:
{
  "understood": boolean,            // did you follow the point?
  "engagement_likelihood": number,  // 0..1, would you engage (like/retweet/click)?
  "ai_smell_score": number,         // 0..1, higher = feels more LLM-generated / generic
  "depth_score": number,            // 0..1, higher = substantive/new/actionable for someone like you
  "comments": string                // 1-2 sentences explaining your scores, concrete
}
No other text.`;

function parseFeedback(text: string, persona: EvaluatorPersona): AudienceFeedback {
  try {
    const obj = JSON.parse(text.trim()) as {
      understood?: boolean;
      engagement_likelihood?: number;
      ai_smell_score?: number;
      depth_score?: number;
      comments?: string;
    };
    return {
      from: { kind: "evaluator_persona", id: persona.id },
      understood: Boolean(obj.understood),
      engagement_likelihood: clamp01(obj.engagement_likelihood),
      ai_smell_score: clamp01(obj.ai_smell_score),
      depth_score: clamp01(obj.depth_score),
      comments: String(obj.comments ?? ""),
    };
  } catch {
    return {
      from: { kind: "evaluator_persona", id: persona.id },
      understood: false,
      engagement_likelihood: 0,
      ai_smell_score: 1,
      depth_score: 0,
      comments: `[parse error] raw output: ${text.slice(0, 200)}`,
    };
  }
}

function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export async function simulateAudience(
  llm: LLMClient,
  opts: SimulateOpts,
): Promise<{ feedback: AudienceFeedback[]; cost: CostAccounting }> {
  const platform = opts.platform ?? "social media";
  const calls = opts.personas.map(async (persona) => {
    const result = await llm.complete({
      tier: "cheap",
      system: [
        { text: SYSTEM_TEMPLATE(persona, platform), cache: true },
      ],
      messages: [
        { role: "user", content: `Here is the post to react to:\n\n${opts.variant_text}` },
      ],
      max_tokens: 400,
      temperature: 0.3,
    });
    return { feedback: parseFeedback(result.text, persona), cost: result.cost };
  });
  const results = await Promise.all(calls);
  const cost: CostAccounting = results.reduce(
    (acc, r) => ({
      input_tokens: acc.input_tokens + r.cost.input_tokens,
      output_tokens: acc.output_tokens + r.cost.output_tokens,
      usd: acc.usd + r.cost.usd,
    }),
    { input_tokens: 0, output_tokens: 0, usd: 0 },
  );
  return { feedback: results.map((r) => r.feedback), cost };
}
