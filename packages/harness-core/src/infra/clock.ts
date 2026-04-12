import type { Clock } from "../types.js";

export const systemClock: Clock = { now: () => new Date() };

export function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let t = startMs;
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
  };
}
