import { describe, it, expect } from "vitest";
import { Budget } from "../src/budget.js";
import type { CostAccounting } from "../src/types.js";

const c = (input_tokens: number, output_tokens: number, usd: number): CostAccounting => ({
  input_tokens,
  output_tokens,
  usd,
});

describe("Budget", () => {
  it("starts un-exhausted with no limits and can be charged", () => {
    const b = new Budget({});
    b.charge(c(10, 20, 0.001));
    b.tickIteration();
    const snap = b.snapshot();
    expect(snap.exhausted).toBe(false);
    expect(snap.used_tokens).toBe(30);
    expect(snap.used_usd).toBeCloseTo(0.001);
    expect(snap.iterations).toBe(1);
  });

  it("exhausts on token limit", () => {
    const b = new Budget({ max_tokens: 100 });
    b.charge(c(60, 50, 0));
    expect(b.exhausted()).toBe(true);
    expect(b.snapshot().limit_hit).toBe("tokens");
  });

  it("exhausts on usd limit", () => {
    const b = new Budget({ max_usd: 0.5 });
    b.charge(c(0, 0, 0.6));
    expect(b.exhausted()).toBe(true);
    expect(b.snapshot().limit_hit).toBe("usd");
  });

  it("exhausts on iteration limit", () => {
    const b = new Budget({ max_iterations: 2 });
    b.tickIteration();
    b.tickIteration();
    expect(b.exhausted()).toBe(true);
    expect(b.snapshot().limit_hit).toBe("iterations");
  });

  it("exhausts on wall-clock limit", () => {
    const start = new Date("2026-01-01T00:00:00Z").getTime();
    let now = start;
    const b = new Budget({ max_wall_seconds: 60 }, () => new Date(now));
    now = start + 70_000;
    expect(b.exhausted()).toBe(true);
    expect(b.snapshot().limit_hit).toBe("time");
  });
});
