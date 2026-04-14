# Agent Harness Refactor — Design Spec

**Date:** 2026-04-13
**Status:** approved for v1 implementation
**Scope:** replace the headless TypeScript runtime with a Claude Code skill + subagents, eliminating the Anthropic API key dependency.

---

## 1. Goal

Run the content-harness pipeline end-to-end **inside a Claude Code session**, using Claude Code's subagent mechanism for LLM work, with **no `ANTHROPIC_API_KEY`** required.

The existing implementation is a headless Node pipeline at `packages/harness-core/` + `packages/social-pipeline/` + `bin/run.ts` that instantiates the Anthropic SDK directly. We are replacing the runtime wholesale. Only the zod schemas for user inputs are kept.

## 2. Non-goals (v1)

- Resumability after crash or session restart
- Persisted state / plan / event-log files
- Formal budget accounting (tokens, USD, wall-seconds)
- Formal gate protocol with `NEEDS_GATE_DECISION` round-trips
- Multi-domain support
- Automated tests (unit, e2e, or snapshot)
- Slash command entry point (deferred to v2)
- CI integration
- Web research / external asset retrieval via `research_refs`

These are **deliberately excluded**. If any become necessary post-v1, add them as separate refactors.

## 3. Why the previous architecture's machinery is not needed

The old TypeScript runtime carried machinery designed for five assumptions that do not hold in the new architecture:

| Old assumption | v1 reality |
|---|---|
| Headless runtime, no human present | Human is in the Claude Code session by definition |
| Runs may be long (hours) and may crash | Runs are minutes long; crash recovery = rerun |
| Multiple domains share a harness core | Only one domain (social pipeline) |
| Type system protects correctness | No type system on the orchestration surface |
| Resource accounting matters (token/USD budgets) | No API calls consumed; subagents are free |

Under the new assumptions, the following are dead weight and are removed: `state-latest.json`, `events.jsonl`, `config.json`, `gates/*.json`, `plan` data structure, `budget` accounting, `patch`/`delta`/`verdict` abstractions, controller subagent, 10-step decision table, pre-dispatch budget checks, and fine-grained handler decomposition.

## 4. Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Main Claude Code session (you + me)                     │
│                                                          │
│   - Loads .claude/skills/content-harness/SKILL.md        │
│   - Parses user input YAMLs via packages/schemas         │
│   - Holds pipeline state in conversation memory          │
│   - Dispatches ch-writer and ch-critic subagents         │
│   - Shows intermediate output + asks for approvals       │
│   - Writes final deliverables to runs/<id>/deliverables  │
└─────────────────────────────────────────────────────────┘
                        │
           dispatch (Agent tool)
                        ▼
┌─────────────────────────────────────────────────────────┐
│ ch-writer subagent                                       │
│   Purpose: draft / refine / revise content in persona    │
│   Tools:   none (pure generation)                        │
│   Output:  markdown text                                 │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│ ch-critic subagent                                       │
│   Purpose: score a variant through evaluator personas    │
│   Tools:   none (pure evaluation)                        │
│   Output:  JSON { aggregated_score, verdict, ... }       │
└─────────────────────────────────────────────────────────┘
```

**Key properties:**
- The main session IS the controller. There is no separate controller subagent.
- Pipeline state lives in conversation memory, not on disk. If the session is compressed or restarted mid-run, the run is lost; user reruns.
- Only two subagent roles. They exist solely to provide prompt isolation for creative writing and evaluator-persona voice — not for parallelization or state management.
- The only file the pipeline writes is the final deliverable.

## 5. Components

### 5.1 `packages/schemas/` (only TypeScript package)

```
packages/schemas/
├── package.json       # name: @content-harness/schemas
├── tsconfig.json
└── src/
    ├── persona.ts     # PersonaSchema (moved from social-pipeline)
    ├── campaign.ts    # CampaignSchema (moved from social-pipeline)
    ├── piece.ts       # PieceSchema (moved from social-pipeline)
    └── index.ts       # re-exports
```

- No runtime, no tests, no `bin/`.
- `pnpm -C packages/schemas build` produces `dist/` for the skill's node scripts to require.
- `pnpm -C packages/schemas typecheck` runs `tsc --noEmit` and must pass on every commit.
- The `zod` dep remains.

### 5.2 `.claude/skills/content-harness/SKILL.md`

Frontmatter:

```yaml
---
name: content-harness
description: Run the content-harness pipeline (draft → refine → evaluate → revise → publish) using ch-writer and ch-critic subagents. Trigger on user requests like "run content harness", "跑 harness", or "用 persona/campaign/piece 生成内容".
---
```

Body contains the execution flow defined in Section 6.

### 5.3 `.claude/agents/ch-writer.md`

Subagent definition with frontmatter:

```yaml
---
name: ch-writer
description: Content writer subagent. Drafts a base article from raw materials, refines it into platform-specific variants, or revises an existing variant based on critic feedback. Use when the harness skill dispatches mode=draft, refine, or revise.
---
```

(Exact `tools` frontmatter field syntax will match whatever existing `.claude/agents/*.md` files in the ecosystem use; the implementation plan will verify this.)

System prompt contents:
- Role: an expert content writer whose job is to produce text matching a given persona's voice
- Input shape: mode, persona, and mode-specific fields
- Output contract: **plain markdown**, no JSON wrapper, no metadata
- Behavioral rules: no hedging, no "as an AI" disclaimers, match persona's voice fingerprint, respect platform constraints in refine mode, address every actionable_feedback item in revise mode

### 5.4 `.claude/agents/ch-critic.md`

Subagent definition with frontmatter:

```yaml
---
name: ch-critic
description: Content critic subagent. Reads a variant through the lens of a list of evaluator personas and produces an aggregated score plus actionable feedback. Use when the harness skill dispatches a variant for evaluation.
---
```

System prompt contents:
- Role: a panel of readers, not a helpful assistant; the goal is honest criticism
- Input: variant content, list of evaluator personas, scoring dimensions
- Output contract: **JSON only**, matching this shape:
  ```json
  {
    "aggregated_score": 0.78,
    "per_persona": [
      {"persona_id": "p1", "engagement": 0.8, "ai_smell": 0.2, "depth": 0.7, "comment": "..."}
    ],
    "actionable_feedback": ["tighten the hook", "cut hedging phrases"],
    "verdict": "accept"
  }
  ```
- `verdict` must be one of `accept`, `revise`, `abort`
- Anti-softening rules: explicit instructions to score harshly, penalize AI-sounding hedging, never default to "good with minor nits"

### 5.5 Directory layout (repo-root after refactor)

```
content-harness/
├── .claude/
│   ├── skills/content-harness/SKILL.md
│   └── agents/
│       ├── ch-writer.md
│       └── ch-critic.md
├── packages/
│   └── schemas/
├── data/
│   ├── personas/*.yaml
│   ├── campaigns/*.yaml
│   └── pieces/*.yaml
├── runs/
│   └── <run_id>/deliverables/<platform>.md
├── docs/superpowers/
│   ├── specs/2026-04-13-agent-harness-refactor-design.md  (this file)
│   └── plans/2026-04-13-agent-harness-refactor.md         (next step)
├── pnpm-workspace.yaml   # packages: packages/*
├── package.json          # root
└── tsconfig.base.json    # retained if used by schemas package
```

**Deleted wholesale:**
- `packages/harness-core/` (entire directory)
- `packages/social-pipeline/` (entire directory; schemas move to new package)
- `docs/sprints/` (stale iteration artifacts from previous effort)
- Any `vitest.config.ts`, top-level or per-package test scripts
- `bin/run.ts`

## 6. Execution flow

When the user asks to run the harness (phrases in the skill description), the main session follows this sequence. The skill document presents this as numbered natural-language instructions; the pseudocode below is for this spec only.

```
Step 1: Parse and validate inputs
  Resolve three YAML paths from user request (persona, campaign, piece).
  Run:
    node -e "
      const { PersonaSchema, CampaignSchema, PieceSchema } = require('./packages/schemas/dist/index.js');
      const { parse } = require('yaml');
      const fs = require('fs');
      const [pp, cp, piecep] = process.argv.slice(2);
      const persona  = PersonaSchema.parse(parse(fs.readFileSync(pp,'utf8')));
      const campaign = CampaignSchema.parse(parse(fs.readFileSync(cp,'utf8')));
      const piece    = PieceSchema.parse(parse(fs.readFileSync(piecep,'utf8')));
      console.log(JSON.stringify({persona, campaign, piece}));
    " <persona> <campaign> <piece>
  On validation failure: show the zod error to the user and stop.

Step 2: Present plan and ask for approval (post_plan gate, conversational)
  Show the user, in one message:
    - persona name / voice summary
    - campaign platforms list
    - piece intent + raw_material count
    - intended max_revisions (default 3, ask user to override)
  Ask: "continue?"
  On no: stop the run; no files written.

Step 3: Draft base article
  Dispatch ch-writer with:
    mode: draft
    persona: <persona object>
    piece_input: <piece.input>
  Store returned markdown in conversation as baseArticle.
  Show the user a short summary (title/first paragraph + word count). Do NOT paste full text.

Step 4: For each platform in campaign.platforms:
  4a. Dispatch ch-writer with:
        mode: refine
        persona, base_article: baseArticle, platform, campaign_constraints
      Store returned markdown as currentVariant.
      revisionCount := 0

  4b. Dispatch ch-critic with:
        variant: currentVariant
        evaluator_personas: <persona.evaluator_personas OR default list>
      Parse returned JSON. On parse failure or missing required fields:
        - retry once with stricter instructions
        - if still malformed: treat as revise verdict with feedback "critic returned malformed response"

  4c. Branch on critic verdict + score:
      - If verdict == "accept" OR aggregated_score >= 0.7:
          mark this platform's variant as accepted; continue to next platform.
      - If verdict == "abort":
          tell user "variant for <platform> is unsalvageable per critic". Ask: skip this platform, or abort entire run?
      - If verdict == "revise":
          revisionCount += 1
          If revisionCount > maxRevisions:
              tell user "variant for <platform> hit revision cap (<N>) with score <score>. Force-accept, skip, or abort?"
              act on user's choice.
          Else:
              dispatch ch-writer with:
                mode: revise
                persona, current_variant: currentVariant, actionable_feedback: <from critic>
              update currentVariant to returned markdown
              loop back to 4b.

Step 5: Final review (pre_publish gate, conversational)
  Show the user all accepted variants: platform name + full markdown for each.
  Ask: "publish these to runs/<run_id>/deliverables/?"
  On no: stop; no files written.

Step 6: Write deliverables
  run_id := "run-$(date +%s)"
  mkdir -p runs/<run_id>/deliverables
  For each accepted variant, write runs/<run_id>/deliverables/<platform>.md containing the markdown.
  Tell the user the paths.

End of run.
```

### 6.1 Gate handling

Both gates (`post_plan` at Step 2, `pre_publish` at Step 5) are implemented as **conversational checkpoints** — the main session asks the user directly. There is no gate protocol, no persisted gate decisions, no `NEEDS_GATE_DECISION` status. Either gate can be skipped by the user saying "skip approvals" in their initial request, in which case Step 2 and Step 5 proceed automatically.

### 6.2 Revision limit enforcement

`maxRevisions` is a counter the main session tracks in conversation memory, scoped per platform variant. When the counter exceeds the limit, the main session presents three options (force-accept, skip, abort) and defers to the user. There is no hard cap without user consent, because the user is always present and can make the call.

### 6.3 Error handling

- **YAML parse error / zod validation error:** show the user the error message and stop. No files written.
- **ch-writer returns empty or malformed output:** retry once with explicit instruction to try again. If still empty, show user and ask how to proceed.
- **ch-critic returns non-JSON:** retry once with stricter output-format instruction. If still malformed, treat as a `revise` verdict with feedback "critic returned malformed response".
- **Subagent tool failure (dispatch error):** surface the error to the user; offer to retry or abort.
- **Main session context compression mid-run:** not guarded. Rerun from scratch. Runs should be short enough that this is unlikely.

## 7. Input examples

To run the pipeline the user needs three YAML files. Example skeletons (actual schemas in `packages/schemas/src/`):

```yaml
# data/personas/liuzhe.yaml
id: liuzhe
voice_fingerprint:
  tone: sharp, first-person, low hedging
  forbidden_phrases: ["as an AI", "unfortunately", "it is important to note"]
evaluator_personas:
  - { id: skeptic,   priorities: [depth, originality] }
  - { id: skimmer,   priorities: [engagement, hook]   }
  - { id: engineer,  priorities: [accuracy, clarity]  }
asset_pool_id: liuzhe-pool
```

```yaml
# data/campaigns/april.yaml
id: april-2026
platforms: [twitter, linkedin, xiaohongshu]
constraints:
  twitter:     { max_chars: 280 }
  linkedin:    { max_chars: 1500, tone: professional }
  xiaohongshu: { max_chars: 1000, emoji: true }
```

```yaml
# data/pieces/harness-refactor.yaml
id: harness-refactor
campaign_id: april-2026
persona_id: liuzhe
input:
  intent: announce the refactor of content-harness to zero-API-key mode
  raw_materials:
    - { id: r1, kind: note, content: "...", origin: session-notes }
state: draft
platform_variants: []
eval_history: []
```

If the current `packages/social-pipeline/src/schemas/*.ts` definitions require fields beyond these examples, the fixtures must include them. The plan phase will produce working fixtures.

## 8. What is deleted

The following files and directories are removed wholesale in v1 implementation. This is not a soft deprecation; the code is gone.

```
packages/harness-core/         # entire package
packages/social-pipeline/      # entire package (after moving schemas out)
docs/sprints/                  # stale 2026-04-12 sprint artifacts
```

Per-file deletions inside those packages are implicit. The root `pnpm-workspace.yaml` must be updated to drop references; the root `package.json` scripts must be pruned to only `typecheck` (pointing at schemas).

## 9. Implementation phases

The plan (produced next, via `superpowers:writing-plans`) should decompose into these phases:

1. **Scaffold `packages/schemas/`**: new package with persona/campaign/piece files copied from social-pipeline, stripped of any non-schema imports, re-exported from `src/index.ts`, builds cleanly, typechecks clean.
2. **Delete old packages**: remove `packages/harness-core/`, `packages/social-pipeline/`, update `pnpm-workspace.yaml`, update root `package.json`, ensure `pnpm install` + `pnpm -r typecheck` succeed.
3. **Create `ch-writer` subagent file**: `.claude/agents/ch-writer.md` with frontmatter + system prompt for draft/refine/revise modes.
4. **Create `ch-critic` subagent file**: `.claude/agents/ch-critic.md` with frontmatter + system prompt for persona-panel evaluation returning JSON.
5. **Write `content-harness` skill**: `.claude/skills/content-harness/SKILL.md` containing the execution flow as natural-language numbered steps.
6. **Create example fixtures**: `data/personas/example.yaml`, `data/campaigns/example.yaml`, `data/pieces/example.yaml` that parse cleanly against the new schemas.
7. **Manual end-to-end verification**: run the skill on the example fixtures in a real Claude Code session and observe each step completes, deliverables are written, and gates surface correctly.
8. **Clean up root docs**: update repo README (if one exists) to describe the new architecture and how to run the skill. Drop references to `bin/run.ts` and API keys.

Each phase produces a working repo. If any phase can't complete independently, the plan will subdivide it.

## 10. Open questions deferred to implementation

- Exact wording of the ch-writer and ch-critic system prompts. These will be iterated during manual verification in phase 7.
- Whether `ch-critic`'s evaluator_persona list defaults to a built-in set (matching `DEFAULT_EVALUATOR_PERSONAS` from the old social-pipeline) or requires the persona YAML to supply it. Recommend: built-in default, overridable per-persona.
- Exact handling of `piece.state` field transitions (draft → refining → evaluating → ready). In the old runtime this was enforced by the state machine. In v1 the main session sets it conversationally; final value written to deliverables metadata is TBD during implementation.
- Whether to record a minimal `runs/<run_id>/summary.json` (decision: no for v1, deliverables only).
