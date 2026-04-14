# Sprint 002: critic rubric redesign

**Goal:** Rewrite the `ch-critic` rubric so publishable content can reach 0.80–0.95, eliminate per-persona contradiction-thrash, and make feedback monotone across revise rounds — without touching `SKILL.md` control flow or `ch-writer.md`.

**Why:** The 2026-04-13 iteration experiment proved the current rubric creates a hard ceiling near 0.72 that neither the writer nor the best-of-N logic from sprint 001 can escape: twitter briefly hit 0.74 and regressed to 0.71; linkedin actively fell from 0.72 to 0.67 because the writer fixed one persona's complaint and triggered another's; medium flat-lined at 0.72 across three rounds on three contradictory feedback sets. The critic's harshness calibration (`hedging -0.1`, `list-of-three -0.15`, `AI-generic openings +0.2`) and the three-persona average conflate baseline harshness with actual defects. `verdict: accept` also fires at scores below the platform threshold (0.67 on linkedin with threshold 0.65), which is structurally incoherent. Iterating is rational in theory but hits a persona-contradiction floor in practice.

## Scope

**In-scope files:**
- `.claude/agents/ch-critic.md` — the rubric, persona panel, scoring math, verdict rule, and self-check all live here
- `docs/sprints/002-critic-rubric-redesign-report.md` — new report file

**Out-of-scope (do NOT touch):**
- `.claude/skills/content-harness/SKILL.md` — best-of-N, thresholds, dispatch pattern, retry path, invariants list. If the new rubric needs the skill to pass an extra field or read an extra field, that is a sprint 003 concern; sprint 002 must fit the existing I/O contract at `SKILL.md:129-148`.
- `.claude/agents/ch-writer.md` — no writer-side preservation, no prior-round context passing, no prompt changes. The ceiling is a critic problem.
- `packages/schemas/**` — critic payload is a prompt string, not a typed schema
- `data/**` — the fixture triple is frozen for the acceptance rerun
- `runs/run-1776120705/deliverables/*.md` — these are the non-regression fixtures, read-only
- Any persona lookup from `asset_pool_id` — still future work
- Sprint 001 artifacts (`docs/sprints/001-revise-loop-convergence.md` and its report) — read-only reference

**Scope discipline note:** this sprint must not silently introduce prior-round critic state, writer preservation lists, or any of P4/P5/P6 from `docs/superpowers/plans/2026-04-13-revise-loop-convergence.md`. If the new rubric design subsumes one of those ideas entirely inside `ch-critic.md` (for example, the new rubric is stateless but feedback-monotone by construction), that is acceptable. If it requires the skill to pass `prior_round` state, that is a scope violation — stop and ask the architect.

## Acceptance criteria

**I/O contract preservation (the skill still consumes the critic with zero SKILL.md edits):**
- [ ] The critic still returns a single JSON object with the top-level keys `aggregated_score` (number in [0, 1], 2 decimals), `verdict` (`"accept" | "revise" | "abort"`), `actionable_feedback` (array of strings, imperative, max 5, may be empty on accept), and `per_persona` (array; may be empty only if no persona panel was used). These four keys are read by the skill at `SKILL.md:144` and must remain present with the same types and the same semantics of "present". Any additional keys the new rubric introduces are allowed as long as they are additive and the skill-side parser at `SKILL.md:144-148` continues to succeed on the output.
- [ ] Input contract at `ch-critic.md:9-30` is unchanged in shape. The critic still receives `{variant, platform, evaluator_personas}`. No new input fields required from the skill.

**Rubric redesign (the core change):**
- [ ] **Reachable ceiling.** The rubric's scoring math, as documented in `ch-critic.md`, must be structured so that a piece with zero defects can score ≥ 0.90. Concretely: the document must contain a worked example or explicit statement showing the path to a score in [0.90, 1.00] for a hypothetical defect-free variant. "Defect-free" must be defined by the document, not left to the reader.
- [ ] **Baseline vs. defect separation.** The current rubric's additive penalties (`hedging -0.1`, `list-of-three -0.15`, AI-generic `+0.2 ai_smell`) are either removed or rewritten as thresholded defect flags (e.g. "hedging appears ≥ 3 times in a single paragraph → flag; otherwise ignored"). A single instance of a stylistic pattern must no longer silently dock the score. The rubric document must state the new treatment explicitly and name which of the old additive penalties are retired vs. converted.
- [ ] **Persona contradiction handling.** The rubric must specify what happens when personas disagree about a specific item. Acceptable designs (implementer picks one and justifies in the report):
  1. Report per-persona scores as a spread; aggregate only the agreement-weighted components; only fire `actionable_feedback` items when all personas flag the same element as load-bearing.
  2. Platform-weighted persona trust (e.g. `skimmer` dominates twitter, `engineer` dominates medium); aggregation is a weighted mean, weights documented per platform.
  3. Aggregate by minimum score across personas (most pessimistic) but only surface feedback items that are majority-supported.
  Whichever is chosen, the document must name it, show the aggregation formula, and explain why it does not produce the 0.72 flatline of the current rubric.
- [ ] **Monotone feedback principle.** The rubric document must contain a written principle that addresses the round-N→round-N+1 contradiction pathology observed in the linkedin regression. The principle must be implementable by a stateless critic (no prior-round context from the skill). Example acceptable principles: "never flag an item whose fix would itself be flag-worthy under another rule in this rubric", or "feedback items must name the textual evidence they apply to, and any item whose fix would introduce a new flagged pattern at the same location is suppressed". The document must name the principle and give one concrete example of a feedback item that would have been suppressed under it on the sprint-001 linkedin case (the "at scale that cost is real…" hedge sentence).
- [ ] **Verdict-score coherence.** The rubric must make `verdict: accept` a structural claim that is coherent with the numeric score. Specifically: if the critic emits `verdict: "accept"`, the `aggregated_score` must be ≥ 0.70 AND all per-persona `ai_smell ≤ 0.3` (the current verdict rule at `ch-critic.md:68` already says this — sprint 002 must keep it true in the new rubric and add a sentence that explicitly forbids accepting below 0.70 even if all personas are individually satisfied). The pre-return self-check at `ch-critic.md:72-83` must be updated to enforce this if the new rubric changes the aggregation formula.
- [ ] **Harshness-calibration section replaced, not appended.** The existing `## Harshness calibration (MANDATORY)` block at `ch-critic.md:85-95` must be deleted or rewritten in place. Sprint 002 does not leave both the old and the new rubric in the file. The new file must also not contain the literal strings `hedging -0.1`, `list-of-three -0.15`, or `AI-generic openings +0.2` unless they appear inside a clearly-marked "retired" comment that the writer-facing prompt does not consume.

**Non-regression acceptance rerun (this is the empirical gate):**
- [ ] Run the content-harness skill end-to-end against the fixture triple. Exact arguments:
  - persona: `data/personas/ai-infra-engineer-liu.yaml`
  - campaign: `data/campaigns/q2-infra-insights.yaml`
  - piece: `data/pieces/harness-debug.yaml`
  - platforms: twitter, linkedin, medium (all three)
  - `max_revisions`: 3
  - `skip approvals` enabled
  - Record the new `run_id` and the three deliverable paths under `runs/<run_id>/deliverables/`.
- [ ] **No platform regresses below the sprint-001 accepted scores.** Using the new rubric:
  - twitter final accepted score ≥ **0.71**
  - linkedin final accepted score ≥ **0.72**
  - medium  final accepted score ≥ **0.72**
  The report must list all three numbers. A score below any of these is a hard fail on the non-regression criterion.
- [ ] **Ceiling demonstrably lifted.** At least one of the three platforms must score ≥ **0.80** on the new rubric in the acceptance rerun. The report must name which platform and show its per-persona breakdown (the `per_persona` array from the critic's JSON output).
- [ ] **Iteration does not trap.** Repeat the iteration experiment: take the round-0 accepted variant for each platform and run the skill's revise loop one additional time against it (either by rerunning the skill end-to-end or by dispatching `ch-critic` + `ch-writer` revise directly against the existing deliverables). The report must show:
  - For each of the three platforms, the iter0 score (from the acceptance rerun) and the iter1 score (from the extra revise pass).
  - No iter1 score is more than **0.03** below the corresponding iter0 score. (Noise is expected; a >0.03 drop signals the rubric is still creating regression traps like the sprint-001 linkedin hedging case.)
  - If any iter1 drops >0.03, the implementer must either revise the rubric and rerun until the criterion passes, or document the specific feedback item that caused the regression and explain why it is not a rubric defect. Choosing the latter is grade-zero on this criterion unless the explanation names the exact item and argues from the rubric text.
- [ ] **Report at `docs/sprints/002-critic-rubric-redesign-report.md`** containing:
  1. Run id and the three deliverable paths
  2. Per-platform final scores (iter0) with per-persona breakdown
  3. Iteration experiment table: platform × (iter0, iter1, delta)
  4. The name of the persona-contradiction handling design chosen (one of the three above, or a named alternative)
  5. One concrete example of a feedback item the monotone-feedback principle suppressed on the linkedin hedging case (or a justification if the principle does not apply there)
  6. A one-paragraph self-assessment against the grading rubric below

## Implementation notes

The current `ch-critic.md` has three moving parts you must understand before rewriting:

1. **Output contract block** (`ch-critic.md:38-71`) — defines the JSON shape the skill parses at `SKILL.md:144`. The field-rules bullet list defines `aggregated_score` as `mean(engagement + depth) * (1 - mean(ai_smell))` and the accept rule as `aggregated_score >= 0.7 AND every ai_smell <= 0.3`. The new rubric's aggregation formula goes here; keep the four required keys at the top level.

2. **Pre-return self-check** (`ch-critic.md:72-83`) — sprint 001 added this. It enumerates the four required keys and reminds the critic of the verdict rule. If the new aggregation formula changes, the self-check must be updated to match; otherwise leave it alone.

3. **Harshness calibration** (`ch-critic.md:85-95`) — this is the block sprint 002 is fundamentally rewriting. The five additive penalties here are the source of the 0.72 ceiling. Replacement: convert to thresholded flags, remove outright, or fold into per-persona subjective scoring. Whichever you choose, the replacement must match the acceptance criteria above.

The sprint-001 linkedin regression is your concrete test case. The writer introduced this sentence in iter2 to address feedback about acknowledging cost: "at scale that cost is real and you will eventually need sampling or tiered verbosity." The critic then penalized the sentence as hedging (skimmer persona) and as unsupported speculation (skeptic persona). Your monotone-feedback principle should suppress one of those two complaints, because the sentence was added in response to an earlier feedback item that asked for exactly this acknowledgment. A stateless critic can achieve this by recognizing that a cost-acknowledgment clause is itself a valid response to a "name the tradeoff" feedback pattern — the rubric should not have both "acknowledge cost" and "don't hedge" as simultaneously-fireable rules on the same textual span.

The non-regression fixtures live at `runs/run-1776120705/deliverables/{twitter,linkedin,medium}.md`. These are the sprint-001 accepted variants at scores 0.71/0.72/0.72 on the old rubric. Your new rubric should score them at ≥ the same numbers, and at least one should score ≥ 0.80. You can validate this by dispatching `ch-critic` directly against each file's contents as a sanity check before running the full end-to-end pipeline.

Contract ambiguities pinned down:

1. **"At least one platform ≥ 0.80"** — the acceptance rerun must produce a new set of deliverables, not reuse the sprint-001 ones. The ≥ 0.80 requirement is on the new deliverables. If the new rubric scores one of the sprint-001 deliverables at ≥ 0.80 but the new rerun produces a worse variant that scores below, the sprint fails the ceiling criterion.
2. **"No platform regresses"** — comparison is new-rubric score of new deliverable vs. old-rubric score of old deliverable. These are two different rubrics, so this is not a pure comparison; it is a floor. The intent is that the new rubric not be so harsh that it scores the sprint-001 twitter below 0.71. If the new rubric produces a score of 0.80 for twitter and the new-rubric score of the sprint-001 twitter would be 0.68, the sprint passes — the floor applies to the *new* run's final accepted score, not to cross-rubric comparison.
3. **"Iteration does not trap" (≤ 0.03 drop)** — delta is computed as `iter1 - iter0` on the new rubric. Both numbers must come from the new rubric. The 0.03 tolerance is noise budget; any drop larger than that indicates a rubric-level regression trap like the sprint-001 linkedin case and must be treated as a defect.
4. **Stateless requirement** — the critic may not request prior-round data from the skill. The skill's dispatch prompt at `SKILL.md:129-140` is not changing. If your design needs prior-round context, you have scope-crept into P6 from the plan and must stop.
5. **Defect-free worked example** — the "path to 0.90+" requirement can be satisfied with a short "worked example" block in `ch-critic.md` showing hypothetical per-persona scores and the resulting aggregated_score. It does not require an actual piece to exist at 0.90 in the acceptance rerun.
6. **Verdict vs. score coherence** — if the new aggregation formula produces `aggregated_score = 0.68` but all personas individually like the piece, the critic must NOT emit `verdict: "accept"`. The structural claim is: `accept` implies the numeric score is also above the universal 0.70 floor. The skill's own platform-threshold table (`SKILL.md:157-162`) is separate and can still fire auto-accept below 0.70 for twitter/linkedin — that is skill-side policy and out of scope.
7. **Self-check update** — if the new rubric redefines `aggregated_score` (it probably does), the self-check block must be updated so the critic can actually verify the new formula before emitting. Do not leave the self-check referencing a formula the rubric no longer uses.
8. **Report file is new** — no sprint-002 report exists yet. Create it fresh. The contract (this file) is frozen; do not edit it during implementation.

## Grading rubric (100 pts)

| # | Criterion | Weight | How to check |
|---|---|---|---|
| 1 | I/O contract preserved | 8 | `ch-critic.md` diff keeps the four top-level required keys with the same names and types. `SKILL.md` is unchanged (`git diff` shows zero edits to `.claude/skills/content-harness/SKILL.md`). `ch-critic.md` input contract block at lines 9-30 is unchanged in shape — same three input fields. |
| 2 | Harshness-calibration block replaced in place | 8 | `ch-critic.md` no longer contains the literal strings `hedging -0.1`, `list-of-three -0.15`, or `AI-generic openings +0.2` in active rubric text. The old `## Harshness calibration (MANDATORY)` section is either deleted or rewritten. No dual-rubric state where both old and new rules coexist. |
| 3 | Reachable-ceiling design documented | 12 | `ch-critic.md` contains a worked example or explicit statement showing how a defect-free variant reaches `aggregated_score >= 0.90`. "Defect-free" is defined by the document. The aggregation formula is written out (not just "score harshly"). |
| 4 | Baseline-vs-defect separation | 10 | Every stylistic pattern that used to be an additive penalty is now either a thresholded flag (with the threshold named) or removed. No single-instance pattern silently docks the score. The report names which of the old penalties were retired, which were converted, and the new thresholds. |
| 5 | Persona contradiction handling specified | 12 | `ch-critic.md` names its aggregation design (spread+agreement, platform-weighted trust, min+majority, or a named alternative). Formula is written out. Report explains why this avoids the 0.72 flatline. |
| 6 | Monotone feedback principle documented | 12 | `ch-critic.md` contains a named, written principle that addresses round-N→round-N+1 contradictions without requiring prior-round state. Report shows one concrete feedback item that would have been suppressed on the sprint-001 linkedin hedging case (or a defensible argument why the principle does not apply there). |
| 7 | Verdict-score coherence enforced | 6 | `ch-critic.md` accept rule still requires `aggregated_score >= 0.70` AND `every ai_smell <= 0.3`. New rubric does not allow `verdict: "accept"` at scores below 0.70. Pre-return self-check updated to match the new aggregation formula if it changed. |
| 8 | Acceptance rerun non-regression | 12 | Report shows twitter ≥ 0.71, linkedin ≥ 0.72, medium ≥ 0.72 on the new rubric's acceptance rerun. Missing any of the three numbers is zero on this criterion. Any number below its floor is zero on this criterion. |
| 9 | Ceiling demonstrably lifted | 12 | Report shows at least one platform scoring ≥ 0.80 in the acceptance rerun, with per-persona breakdown. If no platform reaches 0.80, zero. If the 0.80 is achieved by a contrived variant and not the actual skill-end-to-end output, zero. |
| 10 | Iteration experiment: no trap | 10 | Report shows iter0 and iter1 scores for all three platforms from a repeat of the iteration experiment. No iter1 is more than 0.03 below its iter0. If any drop exceeds 0.03, zero unless the report contains a rubric-text-grounded argument that the item causing the drop is a genuine defect and not a rubric contradiction. |
| 11 | No scope creep | 6 | `git diff` touches only `.claude/agents/ch-critic.md`, `docs/sprints/002-critic-rubric-redesign-report.md`, and new files under `runs/<new_run_id>/`. Any edit to `SKILL.md`, `ch-writer.md`, `packages/**`, `data/**`, or the sprint-001 files is automatic zero on this criterion. |
| 12 | Report completeness | 2 | Report contains all six items listed in the "Report at …" acceptance criterion. Missing any item is zero. |

Weights sum to 100 (8+8+12+10+12+12+6+12+12+10+6+2 = 100).

## Expected artifacts from implementer

- Edits confined to `.claude/agents/ch-critic.md`
- An acceptance rerun producing `runs/<new_run_id>/deliverables/{twitter,linkedin,medium}.md`
- Iteration-experiment data captured in the report (six scores: iter0 × 3 platforms, iter1 × 3 platforms)
- Report file at `docs/sprints/002-critic-rubric-redesign-report.md` containing the six items enumerated in the acceptance criterion and a rubric self-assessment
