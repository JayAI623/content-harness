import type { Delta, InfraBundle, Task, TaskHandler } from "./types.js";

export interface RetryConfig {
  max_attempts: number;
  backoff_ms: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runWithRetry<S>(
  handler: TaskHandler<S>,
  task: Task<string>,
  state: S,
  infra: InfraBundle,
  config: RetryConfig,
): Promise<Delta<S>> {
  let attempt = 0;
  let lastFailure: Delta<S> | null = null;

  while (attempt < config.max_attempts) {
    attempt += 1;
    try {
      const result = await handler(task, state, infra);
      if (result.kind === "success") return result;
      lastFailure = result;
      if (!result.error?.retryable) return result;
    } catch (err) {
      lastFailure = {
        kind: "failure",
        patches: [],
        cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
        error: { message: err instanceof Error ? err.message : String(err), retryable: true },
      };
    }

    if (attempt < config.max_attempts && config.backoff_ms > 0) {
      await sleep(config.backoff_ms * attempt);
    }
  }

  return lastFailure ?? {
    kind: "failure",
    patches: [],
    cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
    error: { message: "no attempts made", retryable: false },
  };
}
