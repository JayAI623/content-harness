import type { CostAccounting, Delta, InfraBundle, Task, TaskHandler } from "./types.js";
import { zeroCost } from "./types.js";

export interface RetryConfig {
  max_attempts: number;
  backoff_ms: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function addCost(a: CostAccounting, b: CostAccounting): CostAccounting {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    usd: a.usd + b.usd,
  };
}

export async function runWithRetry<S>(
  handler: TaskHandler<S>,
  task: Task<string>,
  state: S,
  infra: InfraBundle,
  config: RetryConfig,
): Promise<Delta<S>> {
  let attempt = 0;
  let lastFailure: Delta<S> | null = null;
  let accumulated: CostAccounting = zeroCost;

  while (attempt < config.max_attempts) {
    attempt += 1;
    try {
      const result = await handler(task, state, infra);
      accumulated = addCost(accumulated, result.cost);
      if (result.kind === "success") {
        return { ...result, cost: accumulated };
      }
      lastFailure = result;
      if (!result.error?.retryable) {
        return { ...result, cost: accumulated };
      }
    } catch (err) {
      lastFailure = {
        kind: "failure",
        patches: [],
        cost: zeroCost,
        error: { message: err instanceof Error ? err.message : String(err), retryable: true },
      };
      // Thrown errors produce no observable cost — accumulated is unchanged.
    }

    if (attempt < config.max_attempts && config.backoff_ms > 0) {
      await sleep(config.backoff_ms * attempt);
    }
  }

  if (lastFailure) {
    return { ...lastFailure, cost: accumulated };
  }
  return {
    kind: "failure",
    patches: [],
    cost: accumulated,
    error: { message: "no attempts made", retryable: false },
  };
}
