import type { BudgetLimits, BudgetSnapshot, CostAccounting } from "./types.js";

export class Budget {
  private used_tokens = 0;
  private used_usd = 0;
  private iterations = 0;
  private readonly started_at: number;
  private readonly now: () => Date;

  constructor(
    private readonly limits: BudgetLimits,
    now: () => Date = () => new Date(),
  ) {
    this.now = now;
    this.started_at = now().getTime();
  }

  charge(cost: CostAccounting): void {
    this.used_tokens += cost.input_tokens + cost.output_tokens;
    this.used_usd += cost.usd;
  }

  tickIteration(): void {
    this.iterations += 1;
  }

  private wallSeconds(): number {
    return (this.now().getTime() - this.started_at) / 1000;
  }

  private hitLimit(): BudgetSnapshot["limit_hit"] {
    if (this.limits.max_tokens !== undefined && this.used_tokens >= this.limits.max_tokens) return "tokens";
    if (this.limits.max_usd !== undefined && this.used_usd >= this.limits.max_usd) return "usd";
    if (this.limits.max_iterations !== undefined && this.iterations >= this.limits.max_iterations) return "iterations";
    if (this.limits.max_wall_seconds !== undefined && this.wallSeconds() >= this.limits.max_wall_seconds) return "time";
    return undefined;
  }

  exhausted(): boolean {
    return this.hitLimit() !== undefined;
  }

  snapshot(): BudgetSnapshot {
    const limit_hit = this.hitLimit();
    return {
      used_tokens: this.used_tokens,
      used_usd: this.used_usd,
      iterations: this.iterations,
      wall_seconds: this.wallSeconds(),
      exhausted: limit_hit !== undefined,
      ...(limit_hit ? { limit_hit } : {}),
    };
  }
}
