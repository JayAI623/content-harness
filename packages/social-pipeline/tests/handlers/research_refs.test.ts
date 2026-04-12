import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeResearchRefsHandler } from "../../src/handlers/research_refs.js";
import { fakeOpencliClient } from "../../src/opencli-client.js";
import { makeFilesystemAssetStore } from "../../src/asset-store.js";
import { silentLogger, systemClock, fakeLLMClient } from "@content-harness/core";
import type { InfraBundle, Task } from "@content-harness/core";
import { initSocialState } from "../../src/state.js";

const fixtureDir = new URL("../fixtures/opencli/", import.meta.url);

async function loadFixture() {
  const raw = await readFile(new URL("twitter-search.json", fixtureDir), "utf8");
  return JSON.parse(raw);
}

const persona = {
  id: "liu",
  identity: { name: "Liu", one_line_bio: "", long_bio: "" },
  voice: { tone: "analytic", point_of_view: "first-person", vocabulary: { prefer: [], avoid: [] }, example_phrases: [] },
  domain: { primary_topics: ["ai"], expertise_depth: "practitioner" as const, adjacent_topics: [] },
  audience: { description: "eng", pain_points: [], sophistication: "practitioner" as const, evaluator_persona_ids: ["p1"] },
  platforms: [{ platform: "twitter" as const, handle: "liu", priority: 1, role: "primary" as const }],
  style_references: { emulate: [], avoid: [] },
  success_metrics: { primary: "engagement" as const, red_lines: [] },
  asset_pool_id: "liu",
};

const campaign = {
  id: "q2",
  persona_id: "liu",
  goal: "ship",
  timeline: { start: "2026-04-01T00:00:00Z" },
  key_messages: [],
  content_mix: {},
  overrides: {},
  success_criteria: "",
};

const piece = {
  id: "piece1",
  campaign_id: "q2",
  persona_id: "liu",
  input: { raw_materials: [], intent: "explain the loop" },
  state: "draft" as const,
  platform_variants: [],
  eval_history: [],
};

const baseState = () => initSocialState({ persona, campaign, piece });

const task: Task<string> = {
  id: "research_refs_twitter",
  kind: "research_refs",
  params: { platform: "twitter", query: "agent harness loop" },
  deps: [],
  input_refs: [],
  acceptance_criteria: "refs added",
  gate_before: false,
  gate_after: false,
  status: "pending",
};

describe("research_refs handler", () => {
  it("calls opencli, normalizes results, and writes them to asset pool", async () => {
    const root = mkdtempSync(join(tmpdir(), "research-refs-"));
    const fixture = await loadFixture();
    const opencli = fakeOpencliClient({ "agent harness loop": fixture });
    const assets = makeFilesystemAssetStore(root);
    const infra: InfraBundle = {
      llm: fakeLLMClient([]),
      assets,
      logger: silentLogger(),
      clock: systemClock,
    };
    const handler = makeResearchRefsHandler({ opencli });
    const delta = await handler(task, baseState(), infra);
    expect(delta.kind).toBe("success");
    const all = await assets.query<{ id: string }>("liu", "reference_posts");
    expect(all).toHaveLength(3);
    expect(delta.patches.some((p) => p.path.includes("asset_pool_summary"))).toBe(true);
  });

  it("fails gracefully when opencli returns zero results", async () => {
    const root = mkdtempSync(join(tmpdir(), "research-refs-"));
    const opencli = fakeOpencliClient({});
    const assets = makeFilesystemAssetStore(root);
    const infra: InfraBundle = {
      llm: fakeLLMClient([]),
      assets,
      logger: silentLogger(),
      clock: systemClock,
    };
    const handler = makeResearchRefsHandler({ opencli });
    const delta = await handler(task, baseState(), infra);
    expect(delta.kind).toBe("failure");
    expect(delta.error?.retryable).toBe(true);
  });
});
