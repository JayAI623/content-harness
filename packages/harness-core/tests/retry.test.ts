import { describe, it, expect, vi } from "vitest";
import { runWithRetry } from "../src/retry.js";
import type { Delta, InfraBundle, Task, TaskHandler } from "../src/types.js";

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

  it("accumulates cost across retryable failure attempts", async () => {
    let attempt = 0;
    const handler: TaskHandler<{}> = async () => {
      attempt += 1;
      if (attempt < 3) {
        return {
          kind: "failure",
          patches: [],
          cost: { input_tokens: 10, output_tokens: 5, usd: 0.01 },
          error: { message: "transient", retryable: true },
        };
      }
      return {
        kind: "success",
        patches: [],
        cost: { input_tokens: 20, output_tokens: 10, usd: 0.02 },
      };
    };
    const delta = await runWithRetry(
      handler,
      makeTask(),
      {},
      fakeInfra,
      { max_attempts: 5, backoff_ms: 0 },
    );
    expect(delta.kind).toBe("success");
    // 10+10+20 input, 5+5+10 output, 0.01+0.01+0.02 usd
    expect(delta.cost.input_tokens).toBe(40);
    expect(delta.cost.output_tokens).toBe(20);
    expect(delta.cost.usd).toBeCloseTo(0.04, 5);
  });

  it("returns the accumulated cost even when all retries fail", async () => {
    const handler: TaskHandler<{}> = async () => ({
      kind: "failure",
      patches: [],
      cost: { input_tokens: 7, output_tokens: 3, usd: 0.005 },
      error: { message: "flaky", retryable: true },
    });
    const delta = await runWithRetry(
      handler,
      makeTask(),
      {},
      fakeInfra,
      { max_attempts: 3, backoff_ms: 0 },
    );
    expect(delta.kind).toBe("failure");
    expect(delta.cost.input_tokens).toBe(21);
    expect(delta.cost.output_tokens).toBe(9);
    expect(delta.cost.usd).toBeCloseTo(0.015, 5);
  });
});
