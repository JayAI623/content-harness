import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { draftBaseHandler } from "../../src/handlers/draft_base.js";
import { fakeLLMClient, silentLogger, systemClock } from "@content-harness/core";
import type { InfraBundle, Task } from "@content-harness/core";
import { initSocialState } from "../../src/state.js";

const fixtureUrl = new URL("../fixtures/llm/draft-base.json", import.meta.url);

const persona = {
  id: "liu",
  identity: { name: "Liu", one_line_bio: "bio", long_bio: "long" },
  voice: {
    tone: "conversational analytical",
    point_of_view: "first-person practitioner",
    vocabulary: { prefer: ["harness", "loop"], avoid: ["revolutionize"] },
    example_phrases: ["We hit this bug last week."],
  },
  domain: { primary_topics: ["AI infrastructure"], expertise_depth: "practitioner" as const, adjacent_topics: [] },
  audience: { description: "eng", pain_points: ["flakiness"], sophistication: "practitioner" as const, evaluator_persona_ids: ["p1"] },
  platforms: [{ platform: "twitter" as const, handle: "liu", priority: 1, role: "primary" as const }],
  style_references: { emulate: [], avoid: [] },
  success_metrics: { primary: "engagement" as const, red_lines: [] },
  asset_pool_id: "liu",
};

const campaign = {
  id: "q2", persona_id: "liu", goal: "ship",
  timeline: { start: "2026-04-01T00:00:00Z" },
  key_messages: ["observability matters"], content_mix: {}, overrides: {}, success_criteria: "",
};

const piece = {
  id: "piece1", campaign_id: "q2", persona_id: "liu",
  input: {
    raw_materials: [
      { id: "rm1", kind: "text" as const, content: "we had a loop dropping tasks silently", origin: "inline" },
      { id: "rm2", kind: "note" as const, content: "fix was 40 lines but took 5 days to find", origin: "inline" },
    ],
    intent: "explain what I learned from the harness bug",
  },
  state: "draft" as const,
  platform_variants: [],
  eval_history: [],
};

const task: Task<string> = {
  id: "draft_base",
  kind: "draft_base",
  params: {},
  deps: [],
  input_refs: [],
  acceptance_criteria: "base article written",
  gate_before: false,
  gate_after: false,
  status: "pending",
};

describe("draft_base handler", () => {
  it("writes a base article using persona voice + raw materials", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
    const llm = fakeLLMClient([fixture]);
    const infra: InfraBundle = {
      llm,
      assets: { async append() {}, async query() { return []; }, async resolve() { return null; }, async putBlob() { return ""; }, async getBlob() { return null; } },
      logger: silentLogger(),
      clock: systemClock,
    };
    const state = initSocialState({ persona, campaign, piece });
    const delta = await draftBaseHandler(task, state, infra);
    expect(delta.kind).toBe("success");
    expect(delta.patches.some((p) => p.path.includes("base_article"))).toBe(true);
    const call = llm.calls[0]!;
    const systemText = Array.isArray(call.system)
      ? call.system.map((s) => s.text).join("\n")
      : call.system;
    expect(systemText).toContain("harness");
    expect(systemText).toContain("avoid");
    expect(call.messages[0]!.content).toContain("loop dropping tasks");
  });
});
