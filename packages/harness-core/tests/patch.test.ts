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

describe("applyPatch — social-pipeline patch shapes", () => {
  it("handles nested array index as string (eval_variant path)", () => {
    const state = {
      piece: {
        platform_variants: [
          { platform: "x", status: "draft", score: null as number | null },
          { platform: "ig", status: "draft", score: null as number | null },
        ],
      },
    };
    const next = applyPatch(state, {
      op: "set",
      path: ["piece", "platform_variants", "0", "status"],
      value: "accepted",
    });
    expect(next.piece.platform_variants[0]!.status).toBe("accepted");
    expect(next.piece.platform_variants[1]!.status).toBe("draft");
    // Original state must be untouched — applyPatch is pure.
    expect(state.piece.platform_variants[0]!.status).toBe("draft");
  });

  it("append into a nested array creates a new array reference", () => {
    const state = { piece: { platform_variants: [{ platform: "x" }] as Array<{ platform: string }> } };
    const next = applyPatch(state, {
      op: "append",
      path: ["piece", "platform_variants"],
      value: { platform: "ig" },
    });
    expect(next.piece.platform_variants).toHaveLength(2);
    expect(state.piece.platform_variants).toHaveLength(1);
    expect(next.piece.platform_variants).not.toBe(state.piece.platform_variants);
  });

  it("merge into a missing nested field creates it", () => {
    const state = { piece: {} as { meta?: Record<string, unknown> } };
    const next = applyPatch(state, {
      op: "merge",
      path: ["piece", "meta"],
      value: { k: "v" },
    });
    expect(next.piece.meta).toEqual({ k: "v" });
  });
});
