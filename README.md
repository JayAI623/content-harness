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
run content harness with persona data/personas/ai-infra-engineer-liu.yaml, campaign data/campaigns/q2-infra-insights.yaml, piece data/pieces/harness-debug.yaml
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
