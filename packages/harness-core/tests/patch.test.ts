import { describe, it, expect } from "vitest";
import { applyPatch, applyDelta } from "../src/patch.js";

describe("applyPatch", () => {
  it("exports applyPatch and applyDelta", () => {
    expect(typeof applyPatch).toBe("function");
    expect(typeof applyDelta).toBe("function");
  });
});
