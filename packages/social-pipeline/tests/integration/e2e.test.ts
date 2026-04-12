import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  run,
  fakeLLMClient,
  silentLogger,
  systemClock,
  autoApproveGateResolver,
} from "@content-harness/core";
import type { InfraBundle, RunConfig } from "@content-harness/core";
import {
  makeSocialDomain,
  makeFilesystemAssetStore,
  fakeOpencliClient,
  DEFAULT_EVALUATOR_PERSONAS,
} from "../../src/index.js";

let workRoot: string;
beforeEach(async () => { workRoot = await mkdtemp(join(tmpdir(), "social-e2e-")); });
afterEach(async () => { await rm(workRoot, { recursive: true, force: true }); });

const loadFixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

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
  audience: {
    description: "engineers",
    pain_points: ["flakiness"],
    sophistication: "practitioner" as const,
    evaluator_persona_ids: DEFAULT_EVALUATOR_PERSONAS.map((p) => p.id),
  },
  platforms: [{ platform: "twitter" as const, handle: "liu", priority: 1, role: "primary" as const }],
  style_references: { emulate: [], avoid: [] },
  success_metrics: { primary: "engagement" as const, red_lines: [] },
  asset_pool_id: "liu",
};

const campaign = {
  id: "q2", persona_id: "liu", goal: "ship",
  timeline: { start: "2026-04-01T00:00:00Z" },
  key_messages: [], content_mix: {}, overrides: {}, success_criteria: "",
};

const piece = {
  id: "piece1", campaign_id: "q2", persona_id: "liu",
  input: {
    raw_materials: [
      { id: "rm1", kind: "note" as const, content: "loop silently dropping tasks", origin: "inline" },
      { id: "rm2", kind: "note" as const, content: "fix was 40 lines but took 5 days", origin: "inline" },
    ],
    intent: "explain what I learned debugging the harness loop",
  },
  state: "draft" as const,
  platform_variants: [],
  eval_history: [],
};

describe("social-pipeline MVP v1 end-to-end", () => {
  it("produces an accepted twitter variant and writes events.jsonl", async () => {
    const runRoot = join(workRoot, "runs");
    const assetRoot = join(workRoot, "asset-pools");

    const twitterFixture = await loadFixture("opencli/twitter-search.json");
    const draftBase = await loadFixture("llm/draft-base.json");
    const refine = await loadFixture("llm/refine-variant.json");
    const eval1 = await loadFixture("llm/eval-variant-persona-1.json");
    const eval2 = await loadFixture("llm/eval-variant-persona-2.json");
    const eval3 = await loadFixture("llm/eval-variant-persona-3.json");

    const llm = fakeLLMClient([draftBase, refine, eval1, eval2, eval3]);
    const assets = makeFilesystemAssetStore(assetRoot);
    await assets.append("liu", "evaluator_personas", DEFAULT_EVALUATOR_PERSONAS);

    const infra: InfraBundle = {
      llm,
      assets,
      logger: silentLogger(),
      clock: systemClock,
    };
    const domain = makeSocialDomain({
      opencli: fakeOpencliClient({ [piece.input.intent]: twitterFixture }),
    });

    const config: RunConfig = {
      run_id: "e2e",
      run_root: runRoot,
      budget: { max_iterations: 20, max_tokens: 200_000, max_usd: 2, max_wall_seconds: 60 },
      retry: { max_attempts: 2, backoff_ms: 0 },
      gates: { post_plan: false, pre_publish: false },
      gate_resolver: autoApproveGateResolver,
      thresholds: { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 },
      max_revisions: 3,
    };

    const result = await run(domain, { persona, campaign, piece }, config, infra, "social-pipeline");

    expect(result.ok).toBe(true);
    const variants = (result.state as any).piece.platform_variants;
    const accepted = variants.find((v: any) => v.status === "accepted");
    expect(accepted).toBeDefined();
    expect(accepted.eval_score).toBeGreaterThanOrEqual(0.7);

    const events = (await readFile(join(result.run_dir, "events.jsonl"), "utf8")).trim().split("\n");
    expect(events.length).toBeGreaterThanOrEqual(4); // research, draft, refine, eval
  });
});
