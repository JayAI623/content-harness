# Sprint 002 report

**Contract:** `docs/sprints/002-critic-rubric-redesign.md`
**Status:** DONE

## Acceptance criteria

- [x] I/O contract preserved — `ch-critic.md` retains all four top-level keys (`aggregated_score`, `verdict`, `actionable_feedback`, `per_persona`) with the same types; input contract block (lines 9-30) shape is unchanged; `SKILL.md` has zero edits (`git diff` shows only `ch-critic.md`)
- [x] Input contract unchanged — critic still receives `{variant, platform, evaluator_personas}` with no new required fields
- [x] Reachable ceiling documented — `ch-critic.md` contains a worked example (in the "Scoring rubric" section) showing a defect-free variant reaching 0.90+; defect-free is defined by 4 concrete conditions
- [x] Baseline vs. defect separation — old additive penalties retired in place with strikethrough + "RETIRED" labels; all five patterns converted to thresholded flags with explicit thresholds named
- [x] Persona contradiction handling specified — platform-weighted trust design chosen; formula written out; weights table per platform documented; explains why it avoids the 0.72 flatline
- [x] Monotone Feedback Principle documented — named principle written in `ch-critic.md`; concrete example from sprint-001 linkedin hedging case provided; stateless implementation explained via recognized valid-response patterns
- [x] Verdict-score coherence — `accept` rule requires `aggregated_score >= 0.70` AND all `ai_smell <= 0.30`; explicit sentence forbidding accept below 0.70 added; pre-return self-check updated with new formula and the 0.70 floor reminder
- [x] Harshness-calibration block replaced — old `## Harshness calibration (MANDATORY)` block deleted and replaced with the "Scoring rubric" section; literal strings `hedging -0.1`, `list-of-three -0.15`, `AI-generic openings +0.2` appear only in clearly-marked RETIRED strikethough lines
- [x] Acceptance rerun executed — run_id `run-1776122588`; all three platforms accepted; scores at or above non-regression floors
- [x] No platform regresses — twitter 0.76 ≥ 0.71, linkedin 0.76 ≥ 0.72, medium 0.79 ≥ 0.72
- [x] Ceiling demonstrably lifted — medium scored 0.79 in iter0 and 0.80 in iter1; per-persona breakdown provided below
- [x] Iteration does not trap — all three iter1 scores equal or exceed iter0; no drop exceeds 0.03
- [x] Report contains all six items — present below

## Changes

| File | Change |
|---|---|
| `.claude/agents/ch-critic.md` | Full rewrite of scoring rubric: additive penalties retired, platform-weighted persona trust introduced, Monotone Feedback Principle added, worked example for 0.90+ ceiling, pre-return self-check updated |
| `docs/sprints/002-critic-rubric-redesign-report.md` | New report file |

## Run ID and deliverable paths

**run_id:** `run-1776122588`

Deliverable paths:
- `runs/run-1776122588/deliverables/twitter.md`
- `runs/run-1776122588/deliverables/linkedin.md`
- `runs/run-1776122588/deliverables/medium.md`

(Note: `runs/` is gitignored by design per the repo's `.gitignore`. Files are present on disk.)

## Per-platform final scores (iter0) with per-persona breakdown

### Twitter (iter0 score: 0.76)

Platform weights: skimmer=0.50, skeptic=0.25, engineer=0.25

| persona  | weight | engagement | depth | ai_smell | weighted_ed contribution |
|----------|--------|-----------|-------|----------|--------------------------|
| skimmer  | 0.50   | 0.88      | 0.82  | 0.10     | 0.50 × 0.85 = 0.425      |
| skeptic  | 0.25   | 0.84      | 0.85  | 0.12     | 0.25 × 0.845 = 0.211     |
| engineer | 0.25   | 0.82      | 0.86  | 0.08     | 0.25 × 0.84 = 0.210      |

weighted_ed = 0.846, weighted_ai = 0.10
aggregated_score = 0.846 × (1 − 0.10) = **0.76**

### LinkedIn (iter0 score: 0.76)

Platform weights: skimmer=0.25, skeptic=0.35, engineer=0.40

| persona  | weight | engagement | depth | ai_smell | weighted_ed contribution |
|----------|--------|-----------|-------|----------|--------------------------|
| skimmer  | 0.25   | 0.84      | 0.80  | 0.10     | 0.25 × 0.82 = 0.205      |
| skeptic  | 0.35   | 0.83      | 0.87  | 0.11     | 0.35 × 0.85 = 0.298      |
| engineer | 0.40   | 0.82      | 0.86  | 0.09     | 0.40 × 0.84 = 0.336      |

weighted_ed = 0.839, weighted_ai = 0.0995
aggregated_score = 0.839 × (1 − 0.0995) = **0.76**

### Medium (iter0 score: 0.79)

Platform weights: skimmer=0.15, skeptic=0.40, engineer=0.45

| persona  | weight | engagement | depth | ai_smell | weighted_ed contribution |
|----------|--------|-----------|-------|----------|--------------------------|
| skimmer  | 0.15   | 0.85      | 0.83  | 0.10     | 0.15 × 0.84 = 0.126      |
| skeptic  | 0.40   | 0.86      | 0.88  | 0.09     | 0.40 × 0.87 = 0.348      |
| engineer | 0.45   | 0.85      | 0.90  | 0.08     | 0.45 × 0.875 = 0.394     |

weighted_ed = 0.868, weighted_ai = 0.087
aggregated_score = 0.868 × (1 − 0.087) = **0.79**

All platforms: verdict `accept`, all ai_smell ≤ 0.30.

## Iteration experiment

| platform | iter0 | iter1 | delta |
|----------|-------|-------|-------|
| twitter  | 0.76  | 0.77  | +0.01 |
| linkedin | 0.76  | 0.77  | +0.01 |
| medium   | 0.79  | 0.80  | +0.01 |

No iter1 score dropped. All deltas are positive. The iteration-trap criterion (no drop >0.03) is met for all three platforms.

**Medium iter1 per-persona breakdown (score: 0.80):**

| persona  | weight | engagement | depth | ai_smell |
|----------|--------|-----------|-------|----------|
| skimmer  | 0.15   | 0.86      | 0.84  | 0.10     |
| skeptic  | 0.40   | 0.87      | 0.89  | 0.09     |
| engineer | 0.45   | 0.86      | 0.91  | 0.08     |

weighted_ed = 0.877, weighted_ai = 0.087
aggregated_score = 0.877 × 0.913 = **0.80**

## Persona-contradiction handling design chosen

**Design 2: Platform-weighted persona trust.**

The three built-in personas (skimmer, skeptic, engineer) carry different weights depending on platform context. Twitter weights: skimmer=0.50, skeptic=0.25, engineer=0.25. LinkedIn: skimmer=0.25, skeptic=0.35, engineer=0.40. Medium: skimmer=0.15, skeptic=0.40, engineer=0.45.

Aggregation formula: `aggregated_score = sum_p(weight(p) × mean(engagement(p), depth(p))) × (1 − sum_p(weight(p) × ai_smell(p)))`

An `actionable_feedback` item is only emitted when the flagging personas collectively hold ≥ 50% of platform weight.

**Why this avoids the 0.72 flatline:** The sprint-001 flatline arose because equal-weight persona complaints cancelled out every revision — fixing one persona's issue triggered another at the same penalty magnitude. Platform weighting breaks the zero-sum symmetry. On twitter, satisfying the skimmer (0.50 weight) produces a net score improvement even if the skeptic (0.25 weight) is mildly unhappy. On medium, the engineer (0.45) and skeptic (0.40) dominate together, and minority-persona complaints are filtered from actionable_feedback. A piece cannot flatline at 0.72 unless the dominant personas are simultaneously and persistently unsatisfied — which signals a genuine content defect, not a rubric contradiction.

## Monotone Feedback Principle — concrete linkedin hedging example

**The MFP statement:** Before adding a feedback item, verify that implementing the fix would not itself be flaggable under another active rule at the same textual span. If it would, the lower-priority item is suppressed from `actionable_feedback` (accuracy/specificity > engagement > style).

**Sprint-001 linkedin regression case:** The writer introduced "at scale that cost is real and you will eventually need sampling or tiered verbosity" to address prior-round feedback requesting acknowledgment of the cost tradeoff. The next-round critic then flagged this sentence as:
1. Hedging (skimmer: "you will eventually need" is weak)
2. Unsupported speculation (skeptic: "tiered verbosity" not defined)

Under the MFP: the sentence was introduced to satisfy a "name the tradeoff" item. Per the rubric's recognized valid-response pattern, a clause that names a concrete condition ("at scale") and a concrete consequence ("sampling or tiered verbosity") is a tradeoff acknowledgment, not hedging — and accuracy/specificity takes priority over style in the suppression order.

**Suppressed item:** The hedging flag ("you will eventually need" is weak) would have been suppressed from `actionable_feedback` because fixing it (removing the hedge) would eliminate the tradeoff acknowledgment that was explicitly requested in the prior round. The skeptic's request to define "tiered verbosity" remains eligible (it asks for specificity, not for removal of the acknowledgment), but under the ≥ 50% platform weight filter for linkedin, engineer (0.40) + skeptic (0.35) = 0.75 > 0.50 could keep it — however the hedging item from skimmer alone (0.25) would be suppressed. The key suppression is: a cost-acknowledgment clause cannot simultaneously be penalized as hedging.

## Rubric self-assessment

The redesign addressed three structural defects in the old rubric. First, additive penalties were removed and replaced with thresholded flags, which eliminates the mechanical score ceiling at ≈ 0.72 that arose from stacked per-instance docks. Second, the platform-weighted aggregation formula breaks the equal-weight persona symmetry that caused the linkedin regression loop: the dominant persona for a given platform now controls whether a revision improves the score, so the writer has a clear signal rather than a contradictory one. Third, the Monotone Feedback Principle provides a stateless mechanism to suppress contradiction-generating feedback items — specifically suppressing the hedging flag on a tradeoff-acknowledgment clause, which is the exact failure mode the sprint identified. The worked example in `ch-critic.md` shows the arithmetic path to 0.90+ for a defect-free variant, and the acceptance rerun confirms the floor is met (twitter 0.76, linkedin 0.76, medium 0.79) with the ceiling demonstrably lifted (medium 0.79–0.80). The iteration experiment produced only positive deltas (+0.01 on all three platforms), confirming the rubric does not trap the revision loop.
