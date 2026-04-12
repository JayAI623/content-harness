import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFilesystemAssetStore } from "../src/asset-store.js";
import type { AssetRef } from "@content-harness/core";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "social-assets-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("filesystem asset store", () => {
  it("appends and queries reference_posts", async () => {
    const store = makeFilesystemAssetStore(root);
    await store.append("liu", "reference_posts", [
      { id: "rp1", platform: "twitter", author: "a", url: "u", content: "hello", engagement: {}, topic_tags: [], collected_at: "2026-04-01T00:00:00Z", source_query: "ai" },
      { id: "rp2", platform: "twitter", author: "b", url: "u2", content: "world", engagement: {}, topic_tags: [], collected_at: "2026-04-02T00:00:00Z", source_query: "ai" },
    ]);
    const all = await store.query<{ id: string }>("liu", "reference_posts");
    expect(all.map((r) => r.id)).toEqual(["rp1", "rp2"]);
  });

  it("resolves reference_post by id", async () => {
    const store = makeFilesystemAssetStore(root);
    await store.append("liu", "reference_posts", [
      { id: "rp1", platform: "twitter", author: "a", url: "u", content: "hello", engagement: {}, topic_tags: [], collected_at: "2026-04-01T00:00:00Z", source_query: "ai" },
    ]);
    const ref: AssetRef = { kind: "reference_post", id: "rp1" };
    const resolved = await store.resolve<{ id: string; content: string }>("liu", ref);
    expect(resolved?.content).toBe("hello");
  });

  it("resolves evaluator_persona by id from yaml", async () => {
    const store = makeFilesystemAssetStore(root);
    await store.append("liu", "evaluator_personas", [
      { id: "p1", name: "n", background: "b", interests: [], pain_points: [], reading_goals: [], critic_style: "strict", language: "en" },
    ]);
    const resolved = await store.resolve<{ id: string }>("liu", { kind: "evaluator_persona", id: "p1" });
    expect(resolved?.id).toBe("p1");
  });

  it("resolves hot_topic by platform+topic", async () => {
    const store = makeFilesystemAssetStore(root);
    await store.append("liu", "hot_topics", [
      { platform: "twitter", topic: "agents", score: 0.9, observed_window: { from: "a", to: "b" }, expires_at: "c", source: "x" },
    ]);
    const resolved = await store.resolve<{ score: number }>("liu", { kind: "hot_topic", platform: "twitter", topic: "agents" });
    expect(resolved?.score).toBe(0.9);
  });

  it("returns null for unknown ref", async () => {
    const store = makeFilesystemAssetStore(root);
    const resolved = await store.resolve("liu", { kind: "reference_post", id: "nope" });
    expect(resolved).toBeNull();
  });

  it("stores and reads blobs", async () => {
    const store = makeFilesystemAssetStore(root);
    const key = await store.putBlob("liu", "hello.txt", new TextEncoder().encode("hi"));
    const bytes = await store.getBlob("liu", key);
    expect(bytes && new TextDecoder().decode(bytes)).toBe("hi");
  });
});
