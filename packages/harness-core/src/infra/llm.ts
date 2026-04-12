import type { CostAccounting, LLMClient, LLMCompleteOptions, LLMCompleteResult } from "../types.js";

// Cost table (per million tokens, approximate). Callers can override by passing their own `priceTable`.
const DEFAULT_PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-4-6":              { in: 15.0, out: 75.0 },
  "claude-haiku-4-5-20251001":    { in: 0.80, out: 4.00 },
};

function priceFor(model: string, table: Record<string, { in: number; out: number }>, input: number, output: number): number {
  const row = table[model];
  if (!row) return 0;
  return (input * row.in + output * row.out) / 1_000_000;
}

interface AnthropicMessagesCreateParams {
  model: string;
  max_tokens: number;
  system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  temperature?: number;
}

interface AnthropicMessagesCreateResult {
  content: Array<{ type: "text"; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
}

interface AnthropicLikeSdk {
  messages: {
    create(params: AnthropicMessagesCreateParams): Promise<AnthropicMessagesCreateResult>;
  };
}

export interface AnthropicClientConfig {
  sdk: AnthropicLikeSdk;
  mainModel: string;
  cheapModel: string;
  priceTable?: Record<string, { in: number; out: number }>;
}

export function makeAnthropicClient(config: AnthropicClientConfig): LLMClient {
  const table = config.priceTable ?? DEFAULT_PRICES;
  return {
    async complete(opts: LLMCompleteOptions): Promise<LLMCompleteResult> {
      const model = opts.tier === "main" ? config.mainModel : config.cheapModel;
      const systemBlocks = typeof opts.system === "string"
        ? [{ type: "text" as const, text: opts.system }]
        : opts.system.map((s) => ({
            type: "text" as const,
            text: s.text,
            ...(s.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
          }));
      const result = await config.sdk.messages.create({
        model,
        max_tokens: opts.max_tokens,
        system: systemBlocks,
        messages: opts.messages,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      });
      const text = result.content.map((c) => c.text).join("");
      const cost: CostAccounting = {
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        usd: priceFor(model, table, result.usage.input_tokens, result.usage.output_tokens),
      };
      return { text, cost, stop_reason: result.stop_reason };
    },
  };
}

export interface FakeLLMClient extends LLMClient {
  calls: LLMCompleteOptions[];
}

export function fakeLLMClient(responses: LLMCompleteResult[]): FakeLLMClient {
  const queue = [...responses];
  const calls: LLMCompleteOptions[] = [];
  return {
    calls,
    async complete(opts: LLMCompleteOptions): Promise<LLMCompleteResult> {
      calls.push(opts);
      const next = queue.shift();
      if (!next) throw new Error("fakeLLMClient exhausted");
      return next;
    },
  };
}
