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

The schemas package is ESM (`"type": "module"`), so use Node's ESM-compatible loader pattern. Run exactly this bash command (substitute the three user-provided paths at the end):

```bash
node --input-type=module -e "
  import { PersonaSchema, CampaignSchema, PieceSchema } from './packages/schemas/dist/index.js';
  import { parse } from 'yaml';
  import { readFileSync } from 'node:fs';
  const [pp, cp, piecep] = process.argv.slice(2);
  try {
    const persona  = PersonaSchema.parse(parse(readFileSync(pp,'utf8')));
    const campaign = CampaignSchema.parse(parse(readFileSync(cp,'utf8')));
    const piece    = PieceSchema.parse(parse(readFileSync(piecep,'utf8')));
    console.log(JSON.stringify({persona, campaign, piece}, null, 2));
  } catch (err) {
    console.error('VALIDATION_FAILED:', err.message);
    process.exit(1);
  }
" PERSONA_PATH CAMPAIGN_PATH PIECE_PATH
```

(Note: the `yaml` package must be available. If `node` reports `Cannot find package 'yaml'`, run `pnpm add -w yaml` once — yaml is the only runtime dep the skill needs beyond schemas' own.)

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
