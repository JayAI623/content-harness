import { describe, it, expect, vi } from "vitest";
import { runWithRetry } from "../src/retry.js";
import type { Delta, InfraBundle, Task } from "../src/types.js";

const makeTask = (): Task<string> => ({
  id: "t",
  kind: "any",
  params: {},
  deps: [],
  input_refs: [],
  acceptance_criteria: "",
  gate_before: false,
  gate_after: false,
  status: "pending",
});

const fakeInfra = {} as InfraBundle;

const okDelta: Delta<unknown> = {
  kind: "success",
  patches: [],
  cost: { input_tokens: 1, output_tokens: 1, usd: 0 },
};

describe("runWithRetry", () => {
  it("returns success on first attempt", async () => {
    const handler = vi.fn().mockResolvedValue(okDelta);
    const result = await runWithRetry(handler, makeTask(), {}, fakeInfra, { max_attempts: 3, backoff_ms: 0 });
    expect(result.kind).toBe("success");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("retries retryable failure delta then succeeds", async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "failure",
        patches: [],
        cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
        error: { message: "transient", retryable: true },
      } satisfies Delta<unknown>)
      .mockResolvedValueOnce(okDelta);
    const result = await runWithRetry(handler, makeTask(), {}, fakeInfra, { max_attempts: 3, backoff_ms: 0 });
    expect(result.kind).toBe("success");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent failures", async () => {
    const handler = vi.fn().mockResolvedValue({
      kind: "failure",
      patches: [],
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      error: { message: "permanent", retryable: false },
    } satisfies Delta<unknown>);
    const result = await runWithRetry(handler, makeTask(), {}, fakeInfra, { max_attempts: 3, backoff_ms: 0 });
    expect(result.kind).toBe("failure");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("gives up after max_attempts on repeated retryable failures", async () => {
    const handler = vi.fn().mockResolvedValue({
      kind: "failure",
      patches: [],
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      error: { message: "transient", retryable: true },
    } satisfies Delta<unknown>);
    const result = await runWithRetry(handler, makeTask(), {}, fakeInfra, { max_attempts: 2, backoff_ms: 0 });
    expect(result.kind).toBe("failure");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("catches thrown errors and wraps as retryable", async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(okDelta);
    const result = await runWithRetry(handler, makeTask(), {}, fakeInfra, { max_attempts: 3, backoff_ms: 0 });
    expect(result.kind).toBe("success");
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
