import { describe, it, expect } from "vitest";
import { applyPatch, applyDelta } from "../src/patch.js";

describe("applyPatch", () => {
  it("exports applyPatch and applyDelta", () => {
    expect(typeof applyPatch).toBe("function");
    expect(typeof applyDelta).toBe("function");
  });
});

describe("applyPatch — no aliasing", () => {
  it("does not alias the patch value into state (set op)", () => {
    const shared = { nested: { n: 1 } };
    const state = { a: { b: null as { nested: { n: number } } | null } };
    const next = applyPatch(state, { op: "set", path: ["a", "b"], value: shared });
    shared.nested.n = 999;
    expect((next.a.b as { nested: { n: number } }).nested.n).toBe(1);
  });

  it("does not alias the patch value into state (merge op)", () => {
    const shared = { inner: { x: 1 } };
    const state = { meta: {} as Record<string, unknown> };
    const next = applyPatch(state, { op: "merge", path: ["meta"], value: { extra: shared } });
    shared.inner.x = 999;
    expect((next.meta as { extra: { inner: { x: number } } }).extra.inner.x).toBe(1);
  });

  it("does not alias the patch value into state (append op)", () => {
    const shared = { label: "hello" };
    const state = { items: [] as Array<{ label: string }> };
    const next = applyPatch(state, { op: "append", path: ["items"], value: shared });
    shared.label = "mutated";
    expect(next.items[0]!.label).toBe("hello");
  });
});
