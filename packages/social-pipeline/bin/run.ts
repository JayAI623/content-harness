#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import Anthropic from "@anthropic-ai/sdk";
import {
  run,
  cliGateResolver,
  makeAnthropicClient,
  consoleLogger,
  systemClock,
} from "@content-harness/core";
import {
  makeSocialDomain,
  makeFilesystemAssetStore,
  makeOpencliSubprocessClient,
  PersonaSchema,
  CampaignSchema,
  PieceSchema,
  DEFAULT_EVALUATOR_PERSONAS,
} from "../src/index.js";

async function loadYaml<T>(path: string, schema: { parse(v: unknown): T }): Promise<T> {
  const raw = await readFile(path, "utf8");
  return schema.parse(parseYaml(raw));
}

async function main() {
  const { values } = parseArgs({
    options: {
      persona: { type: "string" },
      campaign: { type: "string" },
      piece: { type: "string" },
      "data-root": { type: "string", default: "data" },
      "run-root": { type: "string", default: "runs" },
      "no-gates": { type: "boolean", default: false },
    },
  });

  if (!values.persona || !values.campaign || !values.piece) {
    console.error("usage: pnpm --filter @content-harness/social run dev -- --persona <path> --campaign <path> --piece <path>");
    process.exit(2);
  }

  const persona = await loadYaml(resolve(values.persona), PersonaSchema);
  const campaign = await loadYaml(resolve(values.campaign), CampaignSchema);
  const piece = await loadYaml(resolve(values.piece), PieceSchema);

  const dataRoot = resolve(values["data-root"]!);
  const runRoot = resolve(values["run-root"]!);

  const assetStore = makeFilesystemAssetStore(join(dataRoot, "asset-pools"));

  // Seed evaluator personas into the asset pool (v1 uses hardcoded list if empty).
  const existing = await assetStore.query(persona.asset_pool_id, "evaluator_personas");
  if (existing.length === 0) {
    await assetStore.append(persona.asset_pool_id, "evaluator_personas", DEFAULT_EVALUATOR_PERSONAS);
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const llm = makeAnthropicClient({
    sdk: anthropic as any,
    mainModel: "claude-opus-4-6",
    cheapModel: "claude-haiku-4-5-20251001",
  });

  const domain = makeSocialDomain({ opencli: makeOpencliSubprocessClient() });

  const runId = `run-${Date.now()}`;
  const result = await run(
    domain,
    { persona, campaign, piece },
    {
      run_id: runId,
      run_root: runRoot,
      budget: { max_tokens: 500_000, max_usd: 5, max_iterations: 40, max_wall_seconds: 1800 },
      retry: { max_attempts: 2, backoff_ms: 1000 },
      gates: { post_plan: !values["no-gates"], pre_publish: false },
      gate_resolver: values["no-gates"] ? (async () => "approve" as const) : cliGateResolver(),
      thresholds: { eval_pass: 0.7, ai_smell_max: 0.3, depth_min: 0.5 },
      max_revisions: 3,
    },
    {
      llm,
      assets: assetStore,
      logger: consoleLogger(runId),
      clock: systemClock,
    },
    "social-pipeline",
  );

  if (!result.ok) {
    console.error(`run failed: ${result.reason ?? "unknown"}`);
    process.exit(1);
  }

  const accepted = (result.state as any).piece.platform_variants.find((v: any) => v.status === "accepted");
  if (accepted) {
    const deliverable = join(result.run_dir, "deliverables", "twitter_variant.md");
    await writeFile(deliverable, accepted.content + "\n", "utf8");
    console.log(`\n=== DELIVERED ===`);
    console.log(`platform: ${accepted.platform}`);
    console.log(`score:    ${accepted.eval_score}`);
    console.log(`path:     ${deliverable}\n`);
    console.log(accepted.content);
  } else {
    console.error("no accepted variant was produced");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
