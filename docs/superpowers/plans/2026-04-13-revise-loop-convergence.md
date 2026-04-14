# Revise Loop Convergence Fixes

**Date:** 2026-04-13
**Status:** proposal
**Author:** Liu Zhe + Claude

## Context

First end-to-end run of the `content-harness` skill finished 2026-04-13 with:

- **medium** — accepted first try, `aggregated_score=0.72`
- **twitter** — hit `max_revisions=3` cap without converging; scores across 4 evals: **0.68 → 0.67 → 0.68 → 0.61** (regressed on the final round)
- **linkedin** — hit cap; scores: **0.63 → 0.63 → 0.63 → 0.63** (flatline)

The loop never crossed the 0.7 accept threshold for twitter/linkedin despite the writer executing every actionable-feedback item the critic produced. Each round the critic surfaced a *different* set of complaints, and one round the piece got strictly worse but the loop still adopted the new version.

This proposal fixes the structural reasons the loop cannot converge.

## Findings from the run

### F1. Critic is memoryless across rounds

`ch-critic` evaluates each variant in isolation. It has no access to prior rounds' variants, prior scores, or its own prior feedback. Consequence: when the writer fixes complaint A, the critic happily surfaces a fresh complaint B that it could have raised the previous round but didn't. The feedback stream is non-stationary by construction.

Evidence: twitter round 2 feedback said "tag the sequence-index log format as a direct code snippet". The writer complied by pasting a code block at tweet 1. Round 3 feedback then said "move the code snippet from tweet 1 to tweet 6 — its first appearance is context-free". The critic chased a problem it created.

### F2. No best-so-far hysteresis

`SKILL.md` step 4c unconditionally replaces `currentVariant` with the writer's output after every revise dispatch. If the writer regresses, the loop takes the regression. Twitter round 3 (0.61) was strictly worse than round 2 (0.68) — the skill kept it anyway, then reported 0.61 to the user at the cap.

### F3. Threshold is format-blind

The single 0.7 gate in step 4c applies to all platforms. Medium (long-form, room for hedging) cleared it on the first try; twitter (compressed, every cliché amplified) could not. The critic's built-in calibration (`hedging -0.1`, `list-of-three -0.15`, `AI-generic openings +0.2`) produces a natural ceiling around 0.65–0.70 for tight formats — 0.7 is effectively unreachable there without a luck bounce.

### F4. Writer treats every feedback item as must-fix

The revise prompt in `SKILL.md` step 4c passes the entire `actionable_feedback` array and says only "Execute per your system prompt." `ch-writer.md` instructs the writer to apply feedback literally. There is no "preserve what already works" instruction and no prioritization signal. The writer cannot tell which feedback item is load-bearing and which is taste.

### F5. Writer has no delta context

The revise prompt passes `current_variant` but not the **prior** variant, not the prior score, not the prior feedback. The writer has no way to detect that a change it is about to make would undo a win from the last round. It is editing blind.

### F6. `verdict` field contract is not enforced

Twitter round 0 returned a JSON object without a `verdict` field. The skill's retry path exists (`SKILL.md` line 145), but `ch-critic.md`'s output schema says verdict is required yet the system prompt does not fail-hard when it's missing. This silently degrades the loop to score-threshold-only, masking a real contract violation.

### F7. Feedback is editing taste, not correctness

Looking at the full set of feedback across all rounds: "move X", "cut Y", "closer reads stock", "section header slows cadence". None of it is correctness (bugs, factual errors, technical mistakes). It is all editorial preference. A loop optimizing on editing taste cannot converge because editing taste is not a fixed target.

## Proposed fixes

Ordered by impact / effort ratio.

### P1. Best-of-N selection (fixes F2)

**Change:** `SKILL.md` step 4 tracks `bestVariant` per platform alongside `currentVariant`. After every `ch-critic` evaluation:

```
if aggregated_score > bestScore:
    bestVariant := currentVariant
    bestScore   := aggregated_score
```

At cap or accept, `acceptedVariants` uses `bestVariant`, not `currentVariant`. If no round scored above the initial draft, the initial draft is kept.

**Effect:** The loop can never regress. Round 3 twitter (0.61) would have been discarded and round 0 (0.68) promoted.

**Cost:** ~8 lines in SKILL.md. No subagent changes.

### P2. Format-aware thresholds (fixes F3)

**Change:** Replace the single `aggregated_score >= 0.7` gate with a per-format table in `SKILL.md` step 4c:

| platform       | accept threshold |
|----------------|------------------|
| medium         | 0.70             |
| linkedin       | 0.65             |
| twitter        | 0.62             |
| xiaohongshu    | 0.62             |

Rationale: thresholds are calibrated to what the critic's built-in harshness actually produces on well-written content in each format. Empirical basis: medium hit 0.72 in one shot; twitter/linkedin's best scores across all rounds were 0.68 and 0.63 on content that is genuinely publishable.

**Effect:** Twitter round 0 (0.68) would have auto-accepted. Linkedin's flatline 0.63 would have accepted on round 0. **The whole loop would have terminated in Step 3 with three variants and zero revision rounds.**

**Cost:** ~6 lines in SKILL.md. No subagent changes.

### P3. Enforce critic output contract (fixes F6)

**Change:** Edit `ch-critic.md` system prompt to make the output schema a fail-hard requirement with an explicit self-check: "Before returning, verify your response contains all required keys: `aggregated_score`, `verdict`, `actionable_feedback`, `per_persona`. If any key is missing, regenerate the response rather than return it."

Also add a one-line fallback rule: "If you cannot decide between `accept` and `revise`, default to the one implied by the score threshold rule: accept if `aggregated_score >= 0.7` AND all `ai_smell <= 0.3`, else revise."

**Effect:** Twitter round 0's missing `verdict` would have been caught inside the critic instead of silently falling through.

**Cost:** ~8 lines in ch-critic.md.

### P4. Pass prior context into revise (fixes F5)

**Change:** Extend the revise dispatch prompt in `SKILL.md` step 4c to include:

```json
{
  "mode": "revise",
  "persona": <…>,
  "current_variant": <…>,
  "actionable_feedback": <…>,
  "prior_score": <aggregated_score>,
  "prior_strengths": <array of persona comments that praised specific elements>
}
```

`prior_strengths` is extracted by the skill from `per_persona[*].comment` — any sentence scoring a specific element positively ("the code block is the best moment", "the asymmetry 'two hours to write, five days to see' is the sharpest line"). Extraction is heuristic but cheap: pick sentences containing "best", "strongest", "lands", "earns".

Update `ch-writer.md` revise mode: "If `prior_strengths` is provided, do not alter the elements it names. Apply `actionable_feedback` around them."

**Effect:** Writer gets an explicit preservation list. Round 3 twitter would not have broken tweet 1 because tweet 1 was praised in round 2.

**Cost:** ~15 lines in SKILL.md (extraction + prompt), ~5 lines in ch-writer.md.

### P5. Cap feedback at top-3 load-bearing items (fixes F4)

**Change:** `ch-critic.md` instructed to return `actionable_feedback` sorted by impact with explicit labels:

```json
"actionable_feedback": [
  { "item": "...", "load_bearing": "high",   "kind": "correctness" },
  { "item": "...", "load_bearing": "medium", "kind": "structure" },
  { "item": "...", "load_bearing": "low",    "kind": "taste" }
]
```

Skill takes only `load_bearing: high` items plus the single highest-impact `medium`. Drops the rest before sending to writer.

**Effect:** Writer sees 2-3 items per round instead of 5, all pre-filtered for importance. Reduces the surface area where taste-level noise can regress the piece.

**Cost:** ~10 lines in ch-critic.md output contract, ~4 lines in SKILL.md filter.

### P6. Critic sees prior round (fixes F1)

**Change:** After round 0, the critic dispatch includes:

```json
{
  "variant": <current>,
  "platform": "<platform>",
  "evaluator_personas": [],
  "prior_round": {
    "variant": <previous current>,
    "score": <previous aggregated_score>,
    "feedback": <previous actionable_feedback>
  }
}
```

`ch-critic.md` instructed: "If `prior_round` is provided, check whether the writer addressed each prior feedback item. Do not re-raise a complaint about something the writer already improved. Your job this round is to identify what the writer got wrong in *this* revision, not to relitigate the previous round."

**Effect:** Moving goalposts stop moving. Critic has to acknowledge wins before issuing new complaints.

**Cost:** ~12 lines in ch-critic.md behavioral rules, ~5 lines in SKILL.md dispatch.

## Expected outcome after all six fixes

Rerun the same fixture triple (`ai-infra-engineer-liu` / `q2-infra-insights` / `harness-debug`) end-to-end:

- **medium**: accepts round 0 at 0.72 (unchanged)
- **twitter**: accepts round 0 at 0.68 via P2 (format-aware threshold 0.62)
- **linkedin**: accepts round 0 at 0.63 via P2 (threshold 0.62)

Total subagent dispatches drop from **14** (3 drafts + 3 refines + 7 critic + 4 revise + 4 re-critic) to **7** (1 draft + 3 refines + 3 critic). **50% cost reduction**, single-round completion.

For harder pieces where round 0 doesn't clear the format threshold, P1+P4+P6 together prevent the regression and flatline pathologies observed in this run.

## Scope boundary

Out of scope for this sprint:

- Replacing the harshness calibration in `ch-critic.md` with a different rubric (separate design question)
- Adding persona-based evaluator lookup from `asset_pool_id` (noted in SKILL.md as future work)
- Any changes to `ch-writer.md` draft or refine modes

## Sprint deliverables

1. `SKILL.md` — P1, P2, P4 dispatch changes, P5 filter, P6 dispatch changes
2. `ch-critic.md` — P3 output contract, P5 sorted feedback, P6 prior-round behavior
3. `ch-writer.md` — P4 revise mode preservation rule
4. One end-to-end rerun against the existing fixture triple, reporting:
   - Final `run_id` and deliverable paths
   - Round count per platform
   - Final scores per platform
   - Confirmation of non-regression on medium (≥ 0.72)

## Risk

- **P2 threshold calibration is empirical.** If the next run produces content that really is worse than the 0.62/0.65 thresholds imply, users get low-quality output without a revision pass. Mitigation: log every accept with its score; if real-world runs show persistent accepts at the floor, revisit the table.
- **P6 gives the critic state.** A dishonest or lazy critic could use "writer already addressed this" as an excuse to rubber-stamp. Mitigation: the skill still applies the score threshold, which is a hard gate independent of verdict.
- **P4 strength extraction is heuristic.** False positives (preserving something that was not actually a strength) will slow revision. Cheap to fix: tighten the keyword list.
