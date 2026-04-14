# Agent Harness Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the headless TypeScript runtime (`packages/harness-core` + `packages/social-pipeline` + `bin/run.ts`) with a Claude Code skill + two subagents, so the content-harness pipeline runs entirely inside a Claude Code session with no `ANTHROPIC_API_KEY`.

**Architecture:** The main session acts as the controller, following a natural-language skill. It dispatches `ch-writer` (content generation) and `ch-critic` (persona-panel evaluation) subagents. Pipeline state lives in conversation memory. The only persistent output is the final deliverable markdown in `runs/<run_id>/deliverables/`. The only TypeScript package kept is `packages/schemas/`, holding zod schemas for the three user-input YAML files (persona, campaign, piece). Everything else in `packages/harness-core/` and `packages/social-pipeline/` is deleted wholesale.

**Tech Stack:** pnpm workspaces, TypeScript (schemas only, no runtime), zod, yaml, Claude Code skill + subagent markdown files.

---

## Spec reference

This plan implements `docs/superpowers/specs/2026-04-13-agent-harness-refactor-design.md`. Read it if any task is ambiguous.

## Phase overview

1. **Phase A — Scaffold `packages/schemas/`** (Tasks 1–6): create a new package that holds the zod schemas. No runtime code. Builds and typechecks clean.
2. **Phase B — Delete old packages and wire workspace** (Tasks 7–11): remove `packages/harness-core/`, `packages/social-pipeline/`, `docs/sprints/`, update `pnpm-workspace.yaml` and root `package.json`, confirm `pnpm install && pnpm typecheck` succeed.
3. **Phase C — Create Claude Code artifacts** (Tasks 12–14): write the `ch-writer` and `ch-critic` subagent files and the `content-harness` skill file.
4. **Phase D — Verification and docs** (Tasks 15–16): verify existing YAML fixtures still parse against the new schemas package; add a README note on the new way to run the harness.

Frequent commits. Each task produces a working commit.

## File structure after refactor

```
content-harness/
├── .claude/
│   ├── agents/
│   │   ├── ch-critic.md              # NEW (Task 13)
│   │   ├── ch-writer.md              # NEW (Task 12)
│   │   └── harness-*.md              # existing, untouched
│   └── skills/
│       └── content-harness/
│           └── SKILL.md              # NEW (Task 14)
├── data/                             # existing, untouched
├── docs/
│   └── superpowers/
│       ├── plans/2026-04-13-agent-harness-refactor.md    # this file
│       └── specs/2026-04-13-agent-harness-refactor-design.md
├── packages/
│   └── schemas/                      # NEW (Phase A)
│       ├── package.json              # Task 1
│       ├── tsconfig.json             # Task 1
│       └── src/
│           ├── persona.ts            # Task 2
│           ├── campaign.ts           # Task 3
│           ├── piece.ts              # Task 4
│           ├── asset-pool.ts         # Task 5
│           └── index.ts              # Task 6
├── runs/                             # runtime output only
├── package.json                      # MODIFIED (Task 10)
├── pnpm-workspace.yaml               # unchanged; glob `packages/*` still matches
├── tsconfig.base.json                # existing, untouched
└── README.md                         # MODIFIED (Task 16) if present
```

**Deletions in Phase B:**
- `packages/harness-core/` (entire directory)
- `packages/social-pipeline/` (entire directory)
- `docs/sprints/` (stale sprint artifacts)

---

## Phase A — Scaffold `packages/schemas/`

### Task 1: Create schemas package skeleton

**Files:**
- Create: `packages/schemas/package.json`
- Create: `packages/schemas/tsconfig.json`
- Create: `packages/schemas/src/index.ts`

- [ ] **Step 1: Create `packages/schemas/package.json`**

```json
{
  "name": "@content-harness/schemas",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 2: Create `packages/schemas/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Create empty `packages/schemas/src/index.ts`**

```ts
// Re-exports populated by Tasks 2–6.
export {};
```

- [ ] **Step 4: Install dependencies**

Run: `pnpm install`
Expected: success, `node_modules` populated under `packages/schemas/`, no errors.

- [ ] **Step 5: Verify empty package typechecks**

Run: `pnpm -C packages/schemas typecheck`
Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add packages/schemas/package.json packages/schemas/tsconfig.json packages/schemas/src/index.ts
git commit -m "feat(schemas): scaffold @content-harness/schemas package"
```

---

### Task 2: Copy persona schema

**Files:**
- Create: `packages/schemas/src/persona.ts`
- Modify: `packages/schemas/src/index.ts`

- [ ] **Step 1: Create `packages/schemas/src/persona.ts`**

Paste exactly this content (identical to the current `packages/social-pipeline/src/schemas/persona.ts`, no import changes needed because it has no cross-file imports):

```ts
import { z } from "zod";

export const PlatformEnum = z.enum(["twitter", "linkedin", "medium", "xiaohongshu"]);

export const PlatformBindingSchema = z.object({
  platform: PlatformEnum,
  handle: z.string(),
  priority: z.number().min(0).max(1),
  role: z.enum(["primary", "cross-post", "syndicate"]),
});

export const AccountRefSchema = z.object({
  platform: PlatformEnum,
  handle: z.string(),
  why: z.string(),
});

export const PersonaSchema = z.object({
  id: z.string(),
  identity: z.object({
    name: z.string(),
    one_line_bio: z.string(),
    long_bio: z.string(),
  }),
  voice: z.object({
    tone: z.string(),
    point_of_view: z.string(),
    vocabulary: z.object({ prefer: z.array(z.string()), avoid: z.array(z.string()) }),
    example_phrases: z.array(z.string()),
  }),
  domain: z.object({
    primary_topics: z.array(z.string()),
    expertise_depth: z.enum(["beginner", "practitioner", "expert"]),
    adjacent_topics: z.array(z.string()),
  }),
  audience: z.object({
    description: z.string(),
    pain_points: z.array(z.string()),
    sophistication: z.enum(["layperson", "practitioner", "expert"]),
    evaluator_persona_ids: z.array(z.string()),
  }),
  platforms: z.array(PlatformBindingSchema),
  style_references: z.object({
    emulate: z.array(AccountRefSchema),
    avoid: z.array(AccountRefSchema),
  }),
  success_metrics: z.object({
    primary: z.enum(["engagement", "growth", "clicks", "citations"]),
    red_lines: z.array(z.string()),
  }),
  asset_pool_id: z.string(),
});

export type Persona = z.infer<typeof PersonaSchema>;
export type PlatformBinding = z.infer<typeof PlatformBindingSchema>;
```

- [ ] **Step 2: Update `packages/schemas/src/index.ts`**

Replace the entire contents with:

```ts
export * from "./persona.js";
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm -C packages/schemas typecheck`
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/schemas/src/persona.ts packages/schemas/src/index.ts
git commit -m "feat(schemas): add PersonaSchema"
```

---

### Task 3: Copy campaign schema

**Files:**
- Create: `packages/schemas/src/campaign.ts`
- Modify: `packages/schemas/src/index.ts`

- [ ] **Step 1: Create `packages/schemas/src/campaign.ts`**

```ts
import { z } from "zod";

export const CampaignSchema = z.object({
  id: z.string(),
  persona_id: z.string(),
  goal: z.string(),
  timeline: z.object({
    start: z.string(),
    end: z.string().optional(),
  }),
  key_messages: z.array(z.string()),
  content_mix: z.record(z.number()),
  overrides: z.object({
    platform_weights: z.record(z.number()).optional(),
    audience_additions: z.array(z.string()).optional(),
    voice_tweaks: z.record(z.unknown()).optional(),
  }),
  success_criteria: z.string(),
});

export type Campaign = z.infer<typeof CampaignSchema>;
```

- [ ] **Step 2: Update `packages/schemas/src/index.ts`**

Replace contents with:

```ts
export * from "./persona.js";
export * from "./campaign.js";
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm -C packages/schemas typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/schemas/src/campaign.ts packages/schemas/src/index.ts
git commit -m "feat(schemas): add CampaignSchema"
```

---

### Task 4: Copy piece schema

**Files:**
- Create: `packages/schemas/src/piece.ts`
- Modify: `packages/schemas/src/index.ts`

- [ ] **Step 1: Create `packages/schemas/src/piece.ts`**

Paste exactly this content (identical to the current `packages/social-pipeline/src/schemas/piece.ts`, no cross-file imports needed because `AssetRefSchema` and `StateRefSchema` are defined inline):

```ts
import { z } from "zod";

export const AssetRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reference_post"),    id: z.string() }),
  z.object({ kind: z.literal("style_pattern"),     id: z.string() }),
  z.object({ kind: z.literal("hot_topic"),         platform: z.string(), topic: z.string() }),
  z.object({ kind: z.literal("evaluator_persona"), id: z.string() }),
  z.object({ kind: z.literal("own_post"),          piece_id: z.string(), platform: z.string() }),
  z.object({ kind: z.literal("voice_fingerprint") }),
]);

export const StateRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("raw_material"),     piece_id: z.string(), material_id: z.string() }),
  z.object({ kind: z.literal("base_article"),     piece_id: z.string() }),
  z.object({ kind: z.literal("platform_variant"), piece_id: z.string(), platform: z.string(), variant_idx: z.number() }),
  z.object({ kind: z.literal("eval_round"),       piece_id: z.string(), round: z.number() }),
  z.object({ kind: z.literal("deliverable"),      path: z.string() }),
]);

export const RawMaterialSchema = z.object({
  id: z.string(),
  kind: z.enum(["text", "url", "file", "note"]),
  content: z.string(),
  origin: z.string(),
});

export const PlatformVariantSchema = z.object({
  platform: z.string(),
  content: z.string(),
  constraints_applied: z.array(z.string()),
  inspired_by: z.array(AssetRefSchema),
  style_patterns_applied: z.array(AssetRefSchema),
  status: z.enum(["drafting", "pending_eval", "accepted", "rejected"]),
  eval_score: z.number().optional(),
  revision_count: z.number(),
});

export const AudienceFeedbackSchema = z.object({
  from: AssetRefSchema,
  understood: z.boolean(),
  engagement_likelihood: z.number(),
  ai_smell_score: z.number(),
  depth_score: z.number(),
  comments: z.string(),
});

export const ActionableFeedbackSchema = z.object({
  from: AssetRefSchema,
  category: z.enum(["tone", "structure", "clarity", "depth", "ai_smell", "other"]),
  text: z.string(),
  targets: z.array(StateRefSchema),
  suggested_refs: z.array(AssetRefSchema).optional(),
});

export const EvalRoundSchema = z.object({
  round: z.number(),
  target: StateRefSchema,
  audience_feedback: z.array(AudienceFeedbackSchema),
  aggregated_score: z.number(),
  actionable_feedback: z.array(ActionableFeedbackSchema),
  verdict: z.enum(["accept", "revise", "abort"]),
});

export const PieceSchema = z.object({
  id: z.string(),
  campaign_id: z.string(),
  persona_id: z.string(),
  input: z.object({
    raw_materials: z.array(RawMaterialSchema),
    intent: z.string(),
  }),
  state: z.enum(["draft", "refining", "evaluating", "ready", "published"]),
  base_article: z.object({
    markdown: z.string(),
    produced_at: z.string(),
    source_refs: z.array(AssetRefSchema),
  }).optional(),
  platform_variants: z.array(PlatformVariantSchema),
  eval_history: z.array(EvalRoundSchema),
});

export type SocialAssetRef = z.infer<typeof AssetRefSchema>;
export type SocialStateRef = z.infer<typeof StateRefSchema>;
export type RawMaterial = z.infer<typeof RawMaterialSchema>;
export type PlatformVariant = z.infer<typeof PlatformVariantSchema>;
export type AudienceFeedback = z.infer<typeof AudienceFeedbackSchema>;
export type ActionableFeedback = z.infer<typeof ActionableFeedbackSchema>;
export type EvalRound = z.infer<typeof EvalRoundSchema>;
export type Piece = z.infer<typeof PieceSchema>;
```

- [ ] **Step 2: Update `packages/schemas/src/index.ts`**

Replace contents with:

```ts
export * from "./persona.js";
export * from "./campaign.js";
export * from "./piece.js";
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm -C packages/schemas typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/schemas/src/piece.ts packages/schemas/src/index.ts
git commit -m "feat(schemas): add PieceSchema"
```

---

### Task 5: Copy asset-pool schema

**Files:**
- Create: `packages/schemas/src/asset-pool.ts`
- Modify: `packages/schemas/src/index.ts`

- [ ] **Step 1: Create `packages/schemas/src/asset-pool.ts`**

```ts
import { z } from "zod";

export const ReferencePostSchema = z.object({
  id: z.string(),
  platform: z.string(),
  author: z.string(),
  url: z.string(),
  content: z.string(),
  engagement: z.object({
    likes: z.number().optional(),
    shares: z.number().optional(),
    comments: z.number().optional(),
    views: z.number().optional(),
  }),
  topic_tags: z.array(z.string()),
  collected_at: z.string(),
  expires_at: z.string().optional(),
  source_query: z.string(),
});

export const StylePatternSchema = z.object({
  id: z.string(),
  platform: z.string(),
  pattern_type: z.enum(["opening", "transition", "cta", "tone", "structure", "vocab", "emoji_use", "hashtag_use"]),
  pattern_text: z.string(),
  example_ref_ids: z.array(z.string()),
  extracted_at: z.string(),
});

export const HotTopicSchema = z.object({
  platform: z.string(),
  topic: z.string(),
  score: z.number(),
  observed_window: z.object({ from: z.string(), to: z.string() }),
  expires_at: z.string(),
  source: z.string(),
});

export const EvaluatorPersonaSchema = z.object({
  id: z.string(),
  name: z.string(),
  background: z.string(),
  interests: z.array(z.string()),
  pain_points: z.array(z.string()),
  reading_goals: z.array(z.string()),
  critic_style: z.enum(["strict", "balanced", "generous"]),
  language: z.enum(["en", "zh", "other"]),
});

export const OwnPostSchema = z.object({
  piece_id: z.string(),
  platform: z.string(),
  url: z.string().optional(),
  metrics: z.record(z.number()),
  posted_at: z.string(),
});

export const VoiceFingerprintSchema = z.object({
  vocab_histogram: z.record(z.number()),
  sentence_rhythms: z.string(),
  typical_openings: z.array(z.string()),
  quirks: z.array(z.string()),
  extracted_from_piece_ids: z.array(z.string()),
  updated_at: z.string(),
});

export const AssetPoolSchema = z.object({
  persona_id: z.string(),
  reference_posts: z.array(ReferencePostSchema),
  style_patterns: z.array(StylePatternSchema),
  hot_topics: z.array(HotTopicSchema),
  evaluator_personas: z.array(EvaluatorPersonaSchema),
  own_history: z.array(OwnPostSchema),
  voice_fingerprint: VoiceFingerprintSchema.optional(),
});

export type ReferencePost = z.infer<typeof ReferencePostSchema>;
export type StylePattern = z.infer<typeof StylePatternSchema>;
export type HotTopic = z.infer<typeof HotTopicSchema>;
export type EvaluatorPersona = z.infer<typeof EvaluatorPersonaSchema>;
export type OwnPost = z.infer<typeof OwnPostSchema>;
export type VoiceFingerprint = z.infer<typeof VoiceFingerprintSchema>;
export type AssetPool = z.infer<typeof AssetPoolSchema>;
```

- [ ] **Step 2: Update `packages/schemas/src/index.ts`**

Replace contents with:

```ts
export * from "./persona.js";
export * from "./campaign.js";
export * from "./piece.js";
export * from "./asset-pool.js";
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm -C packages/schemas typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/schemas/src/asset-pool.ts packages/schemas/src/index.ts
git commit -m "feat(schemas): add AssetPoolSchema and evaluator persona schema"
```

---

### Task 6: Build schemas package and sanity-check runtime output

**Files:**
- None (verification only)

- [ ] **Step 1: Clean build**

Run: `pnpm -C packages/schemas build`
Expected: exit 0, creates `packages/schemas/dist/index.js`, `dist/persona.js`, `dist/campaign.js`, `dist/piece.js`, `dist/asset-pool.js` plus matching `.d.ts` files.

- [ ] **Step 2: Verify the compiled output loads and exports work**

Run:

```bash
node -e "
  const m = require('./packages/schemas/dist/index.js');
  const names = Object.keys(m).sort();
  console.log(names.join('\n'));
"
```

Expected stdout to include at minimum these names (order alphabetical):
```
AccountRefSchema
ActionableFeedbackSchema
AssetPoolSchema
AssetRefSchema
AudienceFeedbackSchema
CampaignSchema
EvalRoundSchema
EvaluatorPersonaSchema
HotTopicSchema
OwnPostSchema
PersonaSchema
PieceSchema
PlatformBindingSchema
PlatformEnum
PlatformVariantSchema
RawMaterialSchema
ReferencePostSchema
StatePatternSchema
StateRefSchema
StylePatternSchema
VoiceFingerprintSchema
```

(If `StatePatternSchema` is listed above erroneously — there is no such export; the list should have `StylePatternSchema` only. This step's acceptance is "all `*Schema` names from persona/campaign/piece/asset-pool appear".)

- [ ] **Step 3: Commit (only if dist is gitignored skip this; otherwise commit)**

Check: `git status packages/schemas/dist/`
- If `dist/` is ignored (check root `.gitignore` for `dist` or `packages/*/dist`): skip commit
- If `dist/` is tracked: `git add packages/schemas/dist && git commit -m "build(schemas): initial compiled output"`

---

## Phase B — Delete old packages and wire workspace

### Task 7: Delete `packages/harness-core/`

**Files:**
- Delete: `packages/harness-core/` (entire directory)

- [ ] **Step 1: Remove the directory**

Run: `rm -rf packages/harness-core`
Expected: no output, directory gone.

- [ ] **Step 2: Verify the directory is gone**

Run: `ls packages/`
Expected: only `schemas` and `social-pipeline` remain.

- [ ] **Step 3: Commit the deletion**

```bash
git add -A packages/harness-core
git commit -m "refactor: delete packages/harness-core runtime (replaced by skill + subagents)"
```

---

### Task 8: Delete `packages/social-pipeline/`

**Files:**
- Delete: `packages/social-pipeline/` (entire directory)

- [ ] **Step 1: Sanity-check schemas package is still intact**

Run: `ls packages/schemas/src/`
Expected: `asset-pool.ts campaign.ts index.ts persona.ts piece.ts`

Confirming this before deleting social-pipeline because the social-pipeline directory contains the original schema files; if Phase A was skipped the deletion would lose data.

- [ ] **Step 2: Remove the directory**

Run: `rm -rf packages/social-pipeline`
Expected: no output.

- [ ] **Step 3: Verify only `schemas` remains**

Run: `ls packages/`
Expected: `schemas`

- [ ] **Step 4: Commit the deletion**

```bash
git add -A packages/social-pipeline
git commit -m "refactor: delete packages/social-pipeline (schemas moved to @content-harness/schemas)"
```

---

### Task 9: Delete stale sprint docs

**Files:**
- Delete: `docs/sprints/` (entire directory)

- [ ] **Step 1: Confirm target exists**

Run: `ls docs/sprints/ | head -3`
Expected: at least one file listed (these are the 001/002 sprint contract/report/verdict files from prior work).

- [ ] **Step 2: Remove the directory**

Run: `rm -rf docs/sprints`
Expected: no output.

- [ ] **Step 3: Commit the deletion**

```bash
git add -A docs/sprints
git commit -m "chore: remove stale sprint docs superseded by agent-harness refactor"
```

---

### Task 10: Update root `package.json`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Replace the entire root `package.json` with this content**

```json
{
  "name": "content-harness",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "typescript": "^5.4.5",
    "@types/node": "^20.12.7"
  }
}
```

Changes vs. current:
- Removed `test`, `test:watch`, `dev` scripts (no test runner, no bin)
- Removed `vitest` devDependency
- `build` and `typecheck` still delegate to workspace packages (now only schemas)

- [ ] **Step 2: Verify `pnpm-workspace.yaml` still matches only `packages/*`**

Run: `cat pnpm-workspace.yaml`
Expected output:
```yaml
packages:
  - "packages/*"
```

No changes needed — the glob naturally matches only `packages/schemas/` now.

- [ ] **Step 3: Reinstall to refresh the lockfile**

Run: `pnpm install`
Expected: success, lockfile updated, `node_modules` pruned.

- [ ] **Step 4: Verify whole-repo typecheck still passes**

Run: `pnpm typecheck`
Expected: exit 0, only `@content-harness/schemas` runs, no errors.

- [ ] **Step 5: Verify whole-repo build still passes**

Run: `pnpm build`
Expected: exit 0, `packages/schemas/dist/` populated.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: prune root package.json to schemas-only workspace"
```

---

### Task 11: Remove stray references to deleted packages

**Files:**
- Inspect and potentially modify: `README.md`, `CLAUDE.md`, `.gitignore`, `tsconfig.base.json`

- [ ] **Step 1: Search repo for references to deleted package names**

Run: `grep -rn "harness-core\|social-pipeline\|@content-harness/core\|@content-harness/social" . --include="*.md" --include="*.json" --include="*.yaml" --include="*.yml" --include="*.ts" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs 2>/dev/null || true`

Expected: few or no matches outside `docs/` (the spec and plan files legitimately reference them in historical context).

- [ ] **Step 2: For each match found outside docs/, update or remove the reference**

For each file reported by Step 1:
- If it is a `tsconfig.*.json` `references` array entry: remove the entry
- If it is a script reference in a `package.json`: remove the script
- If it is documentation text (e.g. README): rewrite to point to the new skill/subagent flow, not the deleted packages

If no matches outside docs/, skip to Step 3.

- [ ] **Step 3: Verify typecheck and build still clean**

Run: `pnpm typecheck && pnpm build`
Expected: both exit 0.

- [ ] **Step 4: Commit any changes from Step 2**

If Step 2 made changes:
```bash
git add -A
git commit -m "chore: purge dangling references to deleted packages"
```

If no changes: skip the commit.

---

## Phase C — Create Claude Code artifacts

### Task 12: Create `ch-writer` subagent

**Files:**
- Create: `.claude/agents/ch-writer.md`

- [ ] **Step 1: Create `.claude/agents/ch-writer.md` with exactly this content**

````markdown
---
name: ch-writer
description: Content writer subagent for content-harness. Drafts a base article from raw materials, refines it into a platform-specific variant, or revises an existing variant based on critic feedback. Use when the content-harness skill dispatches with mode=draft, refine, or revise.
model: sonnet
---

You are a professional content writer dispatched by the content-harness pipeline. Your job is to produce text that sounds like a specific persona, not like a helpful AI assistant.

## Input contract

You will receive a single JSON payload with this shape:

```json
{
  "mode": "draft" | "refine" | "revise",
  "persona": { /* Persona object per PersonaSchema */ },
  "piece_input": { /* only in draft mode: {intent, raw_materials} */ },
  "base_article": "...",
  "platform": "twitter",
  "campaign": { /* only in refine mode */ },
  "current_variant": "...",
  "actionable_feedback": [
    "tighten the hook",
    "cut hedging phrases"
  ]
}
```

## Output contract

Return **plain markdown**. No JSON wrapper. No "Here is..." preamble. No post-hoc commentary. Start with the content itself. Do not wrap the output in code fences unless the entire content is literally a code block.

## Mode-specific instructions

### mode = draft

Produce a **base article** in markdown. Aim for 400–1200 words depending on `piece_input.intent`. The base article is platform-agnostic — it is the source-of-truth the refiner will later compress or transform for each platform.

- Structure: strong hook, 2–5 body sections, clear close
- Draw ALL concrete details from `piece_input.raw_materials`. Do not fabricate facts that are not in the raw materials.
- Match `persona.voice.tone`, `persona.voice.point_of_view`, and `persona.voice.vocabulary.prefer`
- Avoid every phrase in `persona.voice.vocabulary.avoid`
- Avoid every item in `persona.success_metrics.red_lines`

### mode = refine

Transform `base_article` into a **platform-specific variant** for `platform`, respecting `campaign.overrides.platform_weights` if present.

Platform constraints you must enforce:
- `twitter`: ≤ 280 characters per post; if content demands more, produce a numbered thread (`1/ ...`, `2/ ...`). Separate posts with a line containing only `---`.
- `linkedin`: ≤ 1500 characters; professional register; allow 1–2 line breaks for rhythm
- `medium`: ≤ 3000 words; long-form; markdown headers allowed
- `xiaohongshu`: ≤ 1000 characters; emoji permitted; hook-first

Hard rules:
- Match persona voice (same `vocabulary.prefer`/`avoid` rules as draft mode)
- Preserve the core message of `base_article`; do not invent new claims
- For twitter threads, use `---` on its own line as post separator so the skill can split later

### mode = revise

Rewrite `current_variant` to address **every item** in `actionable_feedback`. Keep what works; fix what is flagged.

- Do not shorten below the previous length unless a feedback item explicitly asks for it
- Do not add hedging, apologies, or "revised version:" preambles — return the new variant directly
- If a feedback item conflicts with persona voice, prioritize persona voice and silently ignore that feedback item

## Behavioral rules (all modes)

- **Never** write "As an AI..." or any variant of that phrase
- **Never** use phrases listed in `persona.voice.vocabulary.avoid`
- **Never** add disclaimers ("this is a suggestion", "feel free to modify")
- **Never** explain your reasoning — the skill will not read it
- **Never** wrap output in code fences unless the content is literally source code
````

- [ ] **Step 2: Verify the file exists and has the expected frontmatter**

Run: `head -5 .claude/agents/ch-writer.md`
Expected first 5 lines:
```
---
name: ch-writer
description: Content writer subagent for content-harness. Drafts a base article from raw materials, refines it into a platform-specific variant, or revises an existing variant based on critic feedback. Use when the content-harness skill dispatches with mode=draft, refine, or revise.
model: sonnet
---
```

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/ch-writer.md
git commit -m "feat(agents): add ch-writer subagent for draft/refine/revise"
```

---

### Task 13: Create `ch-critic` subagent

**Files:**
- Create: `.claude/agents/ch-critic.md`

- [ ] **Step 1: Create `.claude/agents/ch-critic.md` with exactly this content**

````markdown
---
name: ch-critic
description: Content critic subagent for content-harness. Reads a variant through the lens of a list of evaluator personas and returns a harsh, structured JSON verdict. Use when the content-harness skill dispatches a variant for evaluation.
model: sonnet
---

You are a critic panel dispatched by the content-harness pipeline. Your job is to **score harshly and honestly** — not to be helpful, not to be encouraging.

## Input contract

JSON payload:

```json
{
  "variant": "full markdown text of the variant being evaluated",
  "platform": "twitter",
  "evaluator_personas": [
    {
      "id": "p1",
      "name": "Jane",
      "background": "senior engineer, reads for signal, skips fluff",
      "interests": ["..."],
      "pain_points": ["..."],
      "reading_goals": ["..."],
      "critic_style": "strict",
      "language": "en"
    }
  ]
}
```

If `evaluator_personas` is empty or missing, use a built-in default panel of three:
- `skeptic` (prioritizes depth and originality; dings anything that sounds like a summary of a summary)
- `skimmer` (prioritizes hook and engagement; bails on any text that does not earn the first five seconds)
- `engineer` (prioritizes accuracy and clarity; hates unsupported adjectives)

## Output contract

Return a **single JSON object**, nothing else. No markdown fence. No prose before or after. If you write anything other than valid JSON matching this exact shape, the skill will treat the response as malformed.

```json
{
  "aggregated_score": 0.72,
  "per_persona": [
    {
      "persona_id": "p1",
      "engagement": 0.8,
      "ai_smell": 0.15,
      "depth": 0.7,
      "comment": "Hook is sharp but paragraph 3 hedges"
    }
  ],
  "actionable_feedback": [
    "tighten the hook",
    "cut every use of 'it is important to note'"
  ],
  "verdict": "revise"
}
```

Field rules:
- `aggregated_score`: mean of (engagement + depth) across personas, then multiplied by `(1 - mean(ai_smell))`. Range 0.0–1.0. Round to 2 decimal places.
- `per_persona[*].engagement`: 0.0 (bails on first line) to 1.0 (reads through and shares)
- `per_persona[*].ai_smell`: 0.0 (sounds human) to 1.0 (reads like ChatGPT default voice)
- `per_persona[*].depth`: 0.0 (surface takes) to 1.0 (original framing, non-obvious insight)
- `actionable_feedback`: imperative sentences, each targeting **one** specific issue. Max 5 items. No vague feedback like "make it better".
- `verdict`: one of `"accept"`, `"revise"`, `"abort"`
  - `accept` ONLY if `aggregated_score >= 0.7` AND every `per_persona[*].ai_smell <= 0.3`
  - `abort` ONLY if the content is fundamentally unsalvageable (off-topic, incoherent, or violates persona red_lines)
  - otherwise `revise`

## Harshness calibration (MANDATORY)

Most first-pass LLM drafts score 0.4–0.6 when read honestly. If you find yourself giving 0.8+ on a first-pass draft, you are being soft. Common failure modes to penalize:

- **Hedging**: "it might be worth considering", "one could argue", "this is generally true" → dock engagement by 0.1 per instance
- **List-of-three syndrome**: reflexive bullet lists of exactly 3 items → dock depth by 0.15
- **AI-generic openings**: "In today's fast-paced world...", "Have you ever wondered..." → raise ai_smell by 0.2 per instance
- **Generic closers**: "In conclusion", "Ultimately, the key is..." → raise ai_smell by 0.1
- **Empty adjectives**: "powerful", "robust", "seamless" without evidence → dock depth by 0.05 each

Be specific in comments. "Hook is weak" is useless. "Hook leads with definition instead of stakes" is useful.

## Behavioral rules

- **Never** praise without also docking. If something is good, say so AND find the weakest link.
- **Never** default to "revise" as a safe middle. Score the work honestly and let the verdict rule above decide.
- **Never** rewrite the variant — the writer will do that. You only score and give actionable feedback.
- **Never** output anything outside the JSON object. No preamble. No epilogue. No code fence around the JSON.
````

- [ ] **Step 2: Verify the file exists and has the expected frontmatter**

Run: `head -5 .claude/agents/ch-critic.md`
Expected first 5 lines:
```
---
name: ch-critic
description: Content critic subagent for content-harness. Reads a variant through the lens of a list of evaluator personas and returns a harsh, structured JSON verdict. Use when the content-harness skill dispatches a variant for evaluation.
model: sonnet
---
```

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/ch-critic.md
git commit -m "feat(agents): add ch-critic subagent for persona-panel evaluation"
```

---

### Task 14: Create `content-harness` skill

**Files:**
- Create: `.claude/skills/content-harness/SKILL.md`

- [ ] **Step 1: Create the directory**

Run: `mkdir -p .claude/skills/content-harness`
Expected: no output, directory exists.

- [ ] **Step 2: Create `.claude/skills/content-harness/SKILL.md` with exactly this content**

````markdown
---
name: content-harness
description: Run the content-harness pipeline end-to-end inside Claude Code using the ch-writer and ch-critic subagents, without calling the Anthropic API directly. Triggers on phrases like "run content harness", "跑 harness", "用 persona/campaign/piece 生成内容", or explicit invocation of the content-harness skill.
---

# Content Harness Skill

Orchestrate a draft → refine → evaluate → revise → publish pipeline using two subagents: `ch-writer` (content generation) and `ch-critic` (persona-panel evaluation). Pipeline state lives in this conversation, not on disk. The only file the skill writes is the final deliverable markdown.

## When to use

The user asks to run the content harness, run the social pipeline, generate content from a persona/campaign/piece triple, or any similar phrasing. If the user gives only partial inputs, ask for the missing YAML paths before proceeding — do not guess defaults.

## Inputs

Three YAML files, provided by the user as absolute or repo-relative paths:

1. **persona** (e.g. `data/personas/ai-infra-engineer-liu.yaml`) — must match `PersonaSchema`
2. **campaign** (e.g. `data/campaigns/<campaign>.yaml`) — must match `CampaignSchema`
3. **piece** (e.g. `data/pieces/<piece>.yaml`) — must match `PieceSchema`

Optional parameters the user may specify:
- `max_revisions` (default: 3) — how many revise rounds allowed per platform
- `skip approvals` — bypass the post_plan gate (Step 2) and pre_publish gate (Step 5)

## Prerequisites check

Before Step 1, verify `packages/schemas/dist/index.js` exists. If it does not, run:

```bash
pnpm -C packages/schemas install && pnpm -C packages/schemas build
```

If install or build fails, stop the run and show the error to the user.

## Execution flow

### Step 1. Parse and validate inputs

Run exactly this bash command (substitute the three user-provided paths at the end):

```bash
node -e "
  const { PersonaSchema, CampaignSchema, PieceSchema } = require('./packages/schemas/dist/index.js');
  const { parse } = require('yaml');
  const fs = require('fs');
  const [pp, cp, piecep] = process.argv.slice(2);
  try {
    const persona  = PersonaSchema.parse(parse(fs.readFileSync(pp,'utf8')));
    const campaign = CampaignSchema.parse(parse(fs.readFileSync(cp,'utf8')));
    const piece    = PieceSchema.parse(parse(fs.readFileSync(piecep,'utf8')));
    console.log(JSON.stringify({persona, campaign, piece}, null, 2));
  } catch (err) {
    console.error('VALIDATION_FAILED:', err.message);
    process.exit(1);
  }
" PERSONA_PATH CAMPAIGN_PATH PIECE_PATH
```

(Note: the `yaml` package must be available. If `node -e` reports `Cannot find module 'yaml'`, run `pnpm add -w yaml` once — yaml is the only runtime dep the skill needs beyond schemas' own.)

On exit code 0: parse the stdout as JSON and keep `persona`, `campaign`, `piece` in conversation memory.
On failure: show the `VALIDATION_FAILED:` line to the user and stop the run. Do not proceed.

### Step 2. Present plan and ask for approval (post_plan gate)

Show the user one message containing:
- Persona `identity.name` and `voice.tone` summary
- Campaign `goal`
- Target platform list (take `persona.platforms[].platform`, filter by `campaign.overrides.platform_weights` keys if set)
- Piece `input.intent` plus the count of `input.raw_materials`
- Intended `max_revisions` value (3 unless user specified otherwise)

Ask: **"Continue, or adjust these parameters?"**

If the user's original request contained "skip approvals", auto-proceed past this question.

On "no" or "stop": end the run. Do not write any files.
On "yes": proceed to Step 3.

### Step 3. Draft the base article

Dispatch the `ch-writer` subagent via the Agent tool. The prompt is the literal string:

```
You are handling a content-harness draft request. Execute per your system prompt.

Input:
{
  "mode": "draft",
  "persona": <the persona object as JSON>,
  "piece_input": <the piece.input object as JSON>
}
```

Substitute the actual JSON for the two objects.

Store the returned markdown in conversation memory as `baseArticle`. Show the user:
- First 2 lines of the returned markdown
- Word count (compute with `wc -w` on the content, or count whitespace-separated tokens)

Do NOT paste the full base article to the user; it lives in conversation memory only.

### Step 4. Refine + evaluate + revise loop per platform

For each `platform` in the target platform list from Step 2:

#### 4a. Refine

Dispatch `ch-writer` with prompt:

```
You are handling a content-harness refine request. Execute per your system prompt.

Input:
{
  "mode": "refine",
  "persona": <persona object>,
  "base_article": <baseArticle>,
  "platform": "<platform>",
  "campaign": <campaign object>
}
```

Store the returned markdown as `currentVariant`. Initialize `revisionCount := 0`.

#### 4b. Evaluate

Dispatch `ch-critic` with prompt:

```
You are handling a content-harness evaluation request. Execute per your system prompt.

Input:
{
  "variant": <currentVariant>,
  "platform": "<platform>",
  "evaluator_personas": []
}
```

(v1 passes empty `evaluator_personas` so the critic uses its built-in default panel. Future versions may look up personas from `persona.asset_pool_id` if an asset store is available.)

Parse the returned JSON. Required fields: `aggregated_score` (number), `verdict` (string), `actionable_feedback` (array). If parsing fails OR any required field is missing:
- Retry once by dispatching the critic again with an extra line appended: `Your previous response was not valid JSON. Return ONLY a JSON object per the schema.`
- If the retry is still malformed, synthesize a fallback verdict: `{verdict: "revise", aggregated_score: 0, actionable_feedback: ["critic returned malformed response"], per_persona: []}` and continue.

#### 4c. Branch on verdict

Compute `aiSmellOk := per_persona is empty OR every per_persona[i].ai_smell <= 0.3`.

- **If `verdict == "accept"`** OR **(`aggregated_score >= 0.7` AND `aiSmellOk`)**:
  - Append `{platform, content: currentVariant, score: aggregated_score}` to the in-memory `acceptedVariants` array
  - Continue to the next platform

- **If `verdict == "abort"`**:
  - Tell the user exactly: `variant for <platform> is unsalvageable per critic. Skip this platform or abort the entire run?`
  - On user "skip": continue to next platform without an accepted variant
  - On user "abort": end run, no files written
  - On anything else: treat as skip

- **If `verdict == "revise"` (or the fallback verdict)**:
  - `revisionCount := revisionCount + 1`
  - If `revisionCount > maxRevisions`:
    - Tell the user exactly: `variant for <platform> hit revision cap of <maxRevisions> with score <aggregated_score>. Force-accept current version, skip this platform, or abort run?`
    - On "force-accept": append `{platform, content: currentVariant, score: aggregated_score}` to `acceptedVariants`, continue
    - On "skip": continue to next platform
    - On "abort": end run, no files written
  - Else:
    - Dispatch `ch-writer` in revise mode with prompt:
      ```
      You are handling a content-harness revise request. Execute per your system prompt.

      Input:
      {
        "mode": "revise",
        "persona": <persona object>,
        "current_variant": <currentVariant>,
        "actionable_feedback": <critic's actionable_feedback array>
      }
      ```
    - Update `currentVariant` to the returned markdown
    - Loop back to 4b (re-evaluate this same platform with the new content)

### Step 5. Final review (pre_publish gate)

If `acceptedVariants` is empty: tell the user `no variants accepted; nothing to publish` and end the run.

Otherwise, show the user each accepted variant in full (platform name + complete markdown body + score). Ask: **"Publish these to `runs/<run_id>/deliverables/`?"**

If the user's original request contained "skip approvals", auto-proceed past this question.

On "no": end the run without writing any files.
On "yes": proceed to Step 6.

### Step 6. Write deliverables

Generate the run id:

```bash
echo "run-$(date +%s)"
```

Use that run id for the rest of the step. Create the directory:

```bash
mkdir -p runs/<run_id>/deliverables
```

For each item in `acceptedVariants`, write `runs/<run_id>/deliverables/<platform>.md` containing the variant's markdown content. Use the Write tool for each file.

Tell the user:
- The `run_id`
- The list of written file paths
- One-line summary per file: `<platform>: score <score>`

## Error handling

- **Schema validation error in Step 1**: show the zod error verbatim, stop the run, write nothing
- **Subagent returns empty content in Step 3 or 4a**: dispatch once more with an extra instruction line `Previous response was empty. Return the content directly.` If still empty, show the user and ask how to proceed (retry / skip / abort)
- **Bash command failure (mkdir, date, node)**: show stderr to user, offer retry or abort
- **Conversation context compression mid-run**: not guarded. If pipeline state is lost, tell the user the run is lost and rerun from Step 1.

## Invariants the skill MUST maintain

- Pipeline state lives in THIS conversation — do not persist intermediate state to disk (no state-latest.json, no events.jsonl, no config.json)
- Every subagent dispatch must include the full relevant input in the prompt (subagents have no filesystem access)
- `revisionCount` is per-platform, not global
- Never auto-accept a variant without either the critic's explicit `accept` verdict or meeting the score threshold rule in 4c
- Never write to `runs/` before the pre_publish gate passes (Step 5)
- `maxRevisions` override only happens with explicit user consent (force-accept, skip, or abort)
- When the skill stops for any reason other than Step 6 completing, no files have been written
````

- [ ] **Step 3: Verify the file exists**

Run: `head -5 .claude/skills/content-harness/SKILL.md`
Expected first 5 lines:
```
---
name: content-harness
description: Run the content-harness pipeline end-to-end inside Claude Code using the ch-writer and ch-critic subagents, without calling the Anthropic API directly. Triggers on phrases like "run content harness", "跑 harness", "用 persona/campaign/piece 生成内容", or explicit invocation of the content-harness skill.
---

```

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/content-harness/SKILL.md
git commit -m "feat(skills): add content-harness skill orchestrating ch-writer and ch-critic"
```

---

## Phase D — Verification and docs

### Task 15: Verify existing fixtures parse against new schemas

**Files:**
- None (verification only, possibly adds `yaml` dep to root)

- [ ] **Step 1: Ensure `yaml` is available at the repo root**

Run: `node -e "require('yaml')" 2>&1`

If output contains `Cannot find module 'yaml'`:
```bash
pnpm add -w yaml@^2.4.2
git add package.json pnpm-lock.yaml
git commit -m "chore: add yaml dep at root for skill's node -e parser"
```

Otherwise skip to Step 2.

- [ ] **Step 2: List existing fixtures**

Run: `ls data/personas/ data/campaigns/ data/pieces/ 2>/dev/null`
Expected: at least one yaml file in each directory (e.g. `data/personas/ai-infra-engineer-liu.yaml`).

If any directory is empty, this task cannot verify that directory — note the gap and continue.

- [ ] **Step 3: Parse every persona fixture**

Run (substitute `<file>` for each file in `data/personas/`):

```bash
for f in data/personas/*.yaml; do
  echo "--- $f ---"
  node -e "
    const { PersonaSchema } = require('./packages/schemas/dist/index.js');
    const { parse } = require('yaml');
    const fs = require('fs');
    try {
      PersonaSchema.parse(parse(fs.readFileSync(process.argv[2],'utf8')));
      console.log('OK');
    } catch (err) {
      console.error('FAIL:', err.message);
      process.exit(1);
    }
  " "$f"
done
```

Expected: every file prints `OK`.

If any file prints `FAIL`, **stop** and fix either the schema (if the schema regressed during the copy) or the fixture (if the fixture is out of date). Do not continue until all personas parse.

- [ ] **Step 4: Parse every campaign fixture**

```bash
for f in data/campaigns/*.yaml; do
  echo "--- $f ---"
  node -e "
    const { CampaignSchema } = require('./packages/schemas/dist/index.js');
    const { parse } = require('yaml');
    const fs = require('fs');
    try {
      CampaignSchema.parse(parse(fs.readFileSync(process.argv[2],'utf8')));
      console.log('OK');
    } catch (err) {
      console.error('FAIL:', err.message);
      process.exit(1);
    }
  " "$f"
done
```

Expected: every file prints `OK`. If any fails, stop and fix.

- [ ] **Step 5: Parse every piece fixture**

```bash
for f in data/pieces/*.yaml; do
  echo "--- $f ---"
  node -e "
    const { PieceSchema } = require('./packages/schemas/dist/index.js');
    const { parse } = require('yaml');
    const fs = require('fs');
    try {
      PieceSchema.parse(parse(fs.readFileSync(process.argv[2],'utf8')));
      console.log('OK');
    } catch (err) {
      console.error('FAIL:', err.message);
      process.exit(1);
    }
  " "$f"
done
```

Expected: every file prints `OK`. If any fails, stop and fix.

- [ ] **Step 6: Report and commit any fix-up**

If steps 3–5 required any fixture or schema fix, commit those fixes with a targeted message (e.g. `fix(schemas): accept optional X`). If no fixes were required, this task has no commit.

---

### Task 16: Update README

**Files:**
- Modify: `README.md` (if it exists; create if it does not)

- [ ] **Step 1: Check whether a README exists**

Run: `ls README.md 2>/dev/null && echo EXISTS || echo MISSING`

- [ ] **Step 2: Replace or create `README.md` with the following content**

Write `README.md` containing exactly:

````markdown
# content-harness

A Claude Code-native pipeline for drafting, refining, and evaluating content against a persona + campaign + piece triple.

## How it works

This repo has **no headless runtime and requires no `ANTHROPIC_API_KEY`**. The pipeline runs entirely inside a Claude Code session via a skill + two subagents:

- `.claude/skills/content-harness/SKILL.md` — the orchestration flow (draft → refine → evaluate → revise → publish)
- `.claude/agents/ch-writer.md` — content generation subagent (draft/refine/revise modes)
- `.claude/agents/ch-critic.md` — persona-panel evaluator subagent (returns harsh JSON verdicts)

The only TypeScript package, `packages/schemas/`, exports zod schemas for validating the three YAML input files. Nothing else compiles or runs outside a Claude Code session.

## Running the pipeline

In a Claude Code session at the repo root, say something like:

```
run content harness with persona data/personas/ai-infra-engineer-liu.yaml, campaign data/campaigns/<your-campaign>.yaml, piece data/pieces/<your-piece>.yaml
```

The skill will:

1. Validate the three YAMLs against `PersonaSchema`, `CampaignSchema`, `PieceSchema`
2. Show you a plan and ask for approval
3. Dispatch `ch-writer` to draft a base article
4. For each target platform, dispatch `ch-writer` to refine and `ch-critic` to evaluate; revise up to `max_revisions` times (default 3) if the critic returns `revise`
5. Show you every accepted variant and ask for final approval before writing
6. Write `runs/<run_id>/deliverables/<platform>.md` for each accepted variant

## Optional flags (spoken, not CLI)

- `max_revisions: 5` — raise the revision cap per variant
- `skip approvals` — bypass both conversational gates (post-plan and pre-publish)

## Repo layout

```
.claude/
├── agents/ch-writer.md           # content writer subagent
├── agents/ch-critic.md           # persona-panel critic subagent
└── skills/content-harness/       # pipeline orchestration skill
data/
├── personas/*.yaml               # persona definitions
├── campaigns/*.yaml              # campaign definitions
└── pieces/*.yaml                 # input pieces
packages/schemas/                 # zod schemas (the only TypeScript)
runs/<run_id>/deliverables/       # output markdown files
docs/superpowers/
├── specs/                        # design documents
└── plans/                        # implementation plans
```

## Building schemas

The skill expects `packages/schemas/dist/index.js` to exist. After cloning or pulling:

```bash
pnpm install
pnpm -C packages/schemas build
```

`pnpm typecheck` validates the schemas package.
````

- [ ] **Step 3: Verify**

Run: `head -5 README.md`
Expected first 5 lines:
```
# content-harness

A Claude Code-native pipeline for drafting, refining, and evaluating content against a persona + campaign + piece triple.

## How it works
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for skill + subagent architecture"
```

---

## Post-plan: manual end-to-end verification (human task)

After all 16 tasks complete, the implementer (or user) should run one full end-to-end invocation of the skill in a real Claude Code session:

1. Pick one persona, one campaign, one piece fixture from `data/`
2. Say "run content harness with persona X, campaign Y, piece Z" in a Claude Code session
3. Observe:
   - Step 1 validation prints nothing bad
   - Step 2 plan summary matches the YAML contents
   - Step 3 draft shows up as first-2-lines + word count
   - Step 4 loops through each platform with visible refine + evaluate rounds
   - At least one variant either reaches `accept` or the revision cap triggers
   - Step 5 shows final content
   - Step 6 writes files under `runs/<run_id>/deliverables/`
4. Inspect the written files to confirm content matches what was shown in Step 5

If any step malfunctions, iterate on the relevant subagent prompt or the skill doc, commit the fix, re-verify. This is not a TDD-style automated test — it is an exploratory validation.

Do not mark the refactor "complete" until at least one end-to-end run reaches Step 6 and produces a file.

---

## Rollback note

If the refactor goes sideways after Phase B deletions, the old packages can be restored via:

```bash
git log --all --oneline | grep -E "harness-core|social-pipeline"  # find a pre-refactor commit
git checkout <that-sha> -- packages/harness-core packages/social-pipeline
```

Best not to need this. The git history is the rollback.
