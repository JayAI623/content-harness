import { describe, it, expect, vi } from "vitest";
import { makeAnthropicClient, fakeLLMClient } from "../../src/infra/llm.js";
import type { LLMCompleteOptions } from "../../src/types.js";

describe("fakeLLMClient", () => {
  it("returns scripted responses in order", async () => {
    const client = fakeLLMClient([
      { text: "one", cost: { input_tokens: 1, output_tokens: 1, usd: 0 }, stop_reason: "end_turn" },
      { text: "two", cost: { input_tokens: 2, output_tokens: 2, usd: 0 }, stop_reason: "end_turn" },
    ]);
    const opts: LLMCompleteOptions = { tier: "main", system: "s", messages: [{ role: "user", content: "hi" }], max_tokens: 10 };
    expect((await client.complete(opts)).text).toBe("one");
    expect((await client.complete(opts)).text).toBe("two");
  });

  it("fakeLLMClient remembers received opts", async () => {
    const client = fakeLLMClient([
      { text: "x", cost: { input_tokens: 0, output_tokens: 0, usd: 0 }, stop_reason: "end_turn" },
    ]);
    await client.complete({ tier: "cheap", system: "sys", messages: [{ role: "user", content: "hello" }], max_tokens: 5 });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.tier).toBe("cheap");
  });
});

describe("makeAnthropicClient", () => {
  it("routes tiers to the correct model", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "reply" }],
      usage: { input_tokens: 5, output_tokens: 7 },
      stop_reason: "end_turn",
    });
    const fakeSdk = { messages: { create } } as unknown as Parameters<typeof makeAnthropicClient>[0]["sdk"];
    const client = makeAnthropicClient({ sdk: fakeSdk, mainModel: "claude-opus-4-6", cheapModel: "claude-haiku-4-5-20251001" });
    await client.complete({ tier: "main", system: "you are", messages: [{ role: "user", content: "hi" }], max_tokens: 50 });
    expect(create.mock.calls[0]![0].model).toBe("claude-opus-4-6");
    await client.complete({ tier: "cheap", system: "you are", messages: [{ role: "user", content: "hi" }], max_tokens: 50 });
    expect(create.mock.calls[1]![0].model).toBe("claude-haiku-4-5-20251001");
  });

  it("applies cache_control to cacheable system blocks", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "reply" }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    });
    const fakeSdk = { messages: { create } } as unknown as Parameters<typeof makeAnthropicClient>[0]["sdk"];
    const client = makeAnthropicClient({ sdk: fakeSdk, mainModel: "m", cheapModel: "c" });
    await client.complete({
      tier: "main",
      system: [
        { text: "static big persona block", cache: true },
        { text: "turn-specific", cache: false },
      ],
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
    });
    const arg = create.mock.calls[0]![0];
    expect(Array.isArray(arg.system)).toBe(true);
    expect(arg.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(arg.system[1].cache_control).toBeUndefined();
  });
});
