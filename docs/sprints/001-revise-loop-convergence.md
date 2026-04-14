# Sprint 001: revise loop convergence (P1 + P2 + P3)

**Goal:** Make the content-harness revise loop monotonic, format-aware, and contract-enforced so the existing fixture triple terminates in one round per platform with zero regressions.

**Why:** The 2026-04-13 end-to-end run produced 14 subagent dispatches where 7 were sufficient. Twitter hit the revision cap after its score regressed from 0.68 to 0.61 (the skill kept the worse variant). LinkedIn flatlined at 0.63 against an unreachable 0.70 gate. Twitter round 0 returned a critic JSON missing the `verdict` field and the loop silently fell through to the score-threshold branch. These are three independent structural bugs in `SKILL.md` + `ch-critic.md` that together prevent the loop from converging on tight formats.

## Scope

**In-scope files:**
- `.claude/skills/content-harness/SKILL.md`
- `.claude/agents/ch-critic.md`
- `docs/sprints/001-revise-loop-convergence-report.md` (new)

**Out-of-scope (do NOT touch):**
- `.claude/agents/ch-writer.md` — any revise-mode preservation work belongs to Sprint 002 (P4)
- `packages/schemas/**` — the payload shape the skill passes to the critic is a prompt string, not a schema, no `.ts` changes required
- `data/personas/**`, `data/campaigns/**`, `data/pieces/**` — the acceptance rerun uses existing fixtures unchanged
- `runs/**` — generated output, not source
- Harshness calibration in `ch-critic.md:72-82` (the `Harshness calibration` section) — a separate design question, out of scope per proposal line 178
- Any persona lookup from `asset_pool_id` — noted future work, out of scope

**Scope-split justification (P4/P5/P6 deferred):** The proposal's expected post-fix outcome (`proposal.md` lines 164-170) is that the fixture triple terminates after **zero revise rounds** on all three platforms. That means the code paths P4 (prior context in revise), P5 (load-bearing feedback filter), and P6 (critic sees prior round) never execute during the mandatory acceptance rerun, so they cannot be validated against this sprint's grading signal. Bundling them would add 30–40 lines of prompt plumbing with no observable effect on the acceptance test. Sprint 002 will pick them up against a harder fixture that actually enters the revise branch. P1+P2+P3 are bundled because P1 without P2 still leaves the unreachable-threshold bug, and P3 without P1+P2 still lets a regressed variant through — the three fixes only fully work together.

## Acceptance criteria

- [ ] **P1 — best-so-far hysteresis.** `SKILL.md` step 4 tracks `bestVariant` and `bestScore` per platform alongside `currentVariant`. After every `ch-critic` evaluation, if `aggregated_score > bestScore`, replace `bestVariant`/`bestScore`. On accept, `acceptedVariants` appends `{content: bestVariant, score: bestScore}`, **not** `currentVariant`/`aggregated_score`. On revision-cap `force-accept` (step 4c), also appends `bestVariant`/`bestScore`. The user-facing cap message must report `bestScore`, not the last round's score.
- [ ] **P2 — format-aware accept thresholds.** `SKILL.md` step 4c replaces the single `aggregated_score >= 0.7` gate with a per-platform lookup:
  - `medium` → 0.70
  - `linkedin` → 0.65
  - `twitter` → 0.62
  - `xiaohongshu` → 0.62
  - any other platform → 0.70 (conservative default)
  - The `aiSmellOk` check (`per_persona[*].ai_smell <= 0.3`) still AND-gates the accept. Lookup is on the exact lowercase platform string.
- [ ] **P3 — critic output contract self-check.** `ch-critic.md` system prompt gains an explicit pre-return checklist requiring `aggregated_score`, `verdict`, `actionable_feedback`, `per_persona` to all be present, and adds a tie-breaker clause: "If you are uncertain between `accept` and `revise`, apply the verdict rule in this document (accept iff `aggregated_score >= 0.7` AND every `ai_smell <= 0.3`)." The existing verdict rule at `ch-critic.md:68` remains the single source of truth — P3 reinforces it, does not replace it. Skill-side retry logic at `SKILL.md:144-146` is untouched.
- [ ] **SKILL.md invariants list updated.** The `Invariants the skill MUST maintain` section (`SKILL.md:224-232`) gains one bullet: "Accepted variants always use the best-scoring round for that platform, never the last round unless the last round was the best."
- [ ] **Mandatory acceptance rerun.** Run the content-harness skill end-to-end against the existing fixture triple:
  - persona: `data/personas/ai-infra-engineer-liu.yaml`
  - campaign: `data/campaigns/q2-infra-insights.yaml`
  - piece: `data/pieces/harness-debug.yaml`
  - platforms: twitter, linkedin, medium
  - `max_revisions`: 3 (default)
  - `skip approvals` enabled so the run completes without human gates
  - Report must record: total subagent dispatch count, per-platform revision count, per-platform final accepted score, per-platform accepted variant length in chars/words.
- [ ] **Non-regression on medium.** The medium variant's final score must be ≥ **0.70** (the configured format threshold — proposal says 0.72, which is stochastic; the hard floor is the threshold that P2 installs). Report must print the actual score; if it drops below 0.72 the implementer notes it explicitly.
- [ ] **Dispatch count target.** Total dispatches ≤ **8** (target: 7 = 1 draft + 3 refines + 3 critic; ceiling of 8 allows exactly one P3-driven retry). If dispatches > 8, the implementer must explain in the report which round required revision and why P1/P2 did not terminate it.
- [ ] **Report at `docs/sprints/001-revise-loop-convergence-report.md`** containing: run_id, the three numbers above (dispatches, revisions-per-platform, scores-per-platform), the final deliverable file paths under `runs/<run_id>/deliverables/`, and a one-paragraph self-assessment against the rubric.

## Implementation notes

The revise loop lives entirely in `SKILL.md:104-183`. The `currentVariant` state is introduced at line 125 and rebound at line 182 — P1 adds `bestVariant`/`bestScore` alongside it, updated after the parse at line 144, consumed at line 154 (accept branch), at the force-accept option inside the cap branch, and nowhere else. The accept-threshold check is the single expression at line 152 — P2 replaces the literal `0.7` with a table lookup keyed on the iteration variable from line 106. The critic output contract is `ch-critic.md:38-71` — P3 is additive: append a self-check paragraph after the `Field rules:` block and one sentence to the `Behavioral rules` section. Do not reorder or delete existing rules.

Contract ambiguities pinned down:

1. **"Best-so-far" tie-breaking:** on exact score tie, keep the earlier variant (strict `>` in the update check, not `>=`). This makes the loop prefer earlier rounds, which is slightly safer when scores are noisy.
2. **Initial `bestScore`:** set to `-Infinity` (or `-1`) before round 0 so the first evaluation always seeds both `best` and `current`. Do not seed with 0 — a genuinely-0-scoring draft must still be captured.
3. **P2 platform key normalization:** the skill iterates the platform list from step 2 (`SKILL.md:72`). Those strings come from `persona.platforms[].platform` filtered by campaign weights. Use them verbatim (case-sensitive match); the schema enum is already lowercase. If a future platform is added without a threshold entry, the default 0.70 applies.
4. **P3 "regenerate" semantics:** a subagent is one-shot, so "regenerate" inside the prompt means "review your draft response internally before emitting it". The hard enforcement still lives on the skill side (`SKILL.md:144-146`). The P3 edit reduces the rate of malformed outputs; it does not promise zero.
5. **P3 tie-breaker vs. existing rule:** the existing `ch-critic.md:68` rule already specifies accept semantics. P3's fallback must be phrased as a reminder/tie-breaker, not as a second rule, to avoid ambiguity if the two ever disagree. If they disagree, the rule at line 68 wins.
6. **Acceptance rerun `skip approvals`:** the run must pass `skip approvals` in the invocation so neither the post_plan gate (step 2) nor the pre_publish gate (step 5) requires human input; otherwise the rerun cannot execute unattended.
7. **Dispatch counting:** one dispatch = one `Task`/Agent-tool invocation of `ch-writer` or `ch-critic`. The Node validation bash in step 1 is not a dispatch. Write tool calls in step 6 are not dispatches.
8. **Report format:** the report is a fresh file (no prior sprint reports exist — this is sprint 001). It is NOT the contract; the contract is this file and is frozen the moment it is written.

## Grading rubric (100 pts)

| # | Criterion | Weight | How to check |
|---|---|---|---|
| 1 | P1 best-so-far installed correctly | 22 | `SKILL.md` diff introduces `bestVariant`/`bestScore` per-platform state initialized before round 0 at `-Infinity` (or equivalent), updates only on strict `>` after every `ch-critic` parse, and BOTH the accept branch AND the force-accept branch in the cap handler push `bestVariant`/`bestScore` into `acceptedVariants` instead of `currentVariant`/`aggregated_score`. The cap user-facing message reports `bestScore`. |
| 2 | P2 format-aware threshold table installed | 22 | `SKILL.md` step 4c no longer contains the literal `>= 0.7` for the accept branch; contains a lookup table with exactly these entries: `medium:0.70, linkedin:0.65, twitter:0.62, xiaohongshu:0.62, default:0.70`. `aiSmellOk` still AND-gates the accept. The table is keyed on the per-platform iteration variable. |
| 3 | P3 critic self-check + tie-breaker installed | 16 | `ch-critic.md` diff adds a pre-return self-check enumerating the four required keys (`aggregated_score`, `verdict`, `actionable_feedback`, `per_persona`) and a tie-breaker sentence that explicitly references (does not replace) the verdict rule at the existing line. No existing rule is reordered or deleted. `SKILL.md:144-146` retry path is unchanged. |
| 4 | Invariants list updated | 4 | `SKILL.md`'s `Invariants the skill MUST maintain` section has one new bullet asserting best-scoring round is what gets accepted. |
| 5 | Acceptance rerun completed against fixture triple | 10 | Report file exists at `docs/sprints/001-revise-loop-convergence-report.md`, contains a valid `run_id`, lists three deliverable paths under `runs/<run_id>/deliverables/` (`medium.md`, `linkedin.md`, `twitter.md`), and the files exist on disk. |
| 6 | Dispatch count ≤ 8 | 10 | Report states total subagent dispatches as an integer ≤ 8. If > 8, grade this criterion 0 unless the report contains a specific per-round trace showing which critic evaluation triggered the extra revise and why P1/P2 did not terminate (score strictly below the format threshold on a round that was also strictly worse than the current best). |
| 7 | Non-regression on medium | 8 | Report states the final accepted medium score. If ≥ 0.72, full marks. If in [0.70, 0.72), half marks and the report must explicitly acknowledge the drift. If < 0.70, zero. |
| 8 | No scope creep | 6 | `git diff` touches only: `.claude/skills/content-harness/SKILL.md`, `.claude/agents/ch-critic.md`, `docs/sprints/001-revise-loop-convergence-report.md`, and the new files under `runs/<run_id>/`. Any edit to `ch-writer.md`, `packages/**`, or `data/**` is automatic zero on this criterion. |
| 9 | No dead code / no stale references | 2 | No leftover references to the literal `0.7` threshold in `SKILL.md` (search: `0\.7[^0-9]`). No commented-out blocks. The invariants bullet matches the actual behavior installed. |

Weights sum to 100 (22+22+16+4+10+10+8+6+2).

## Expected artifacts from implementer

- Edits confined to `.claude/skills/content-harness/SKILL.md` and `.claude/agents/ch-critic.md`
- A completed acceptance rerun producing `runs/<run_id>/deliverables/{medium,linkedin,twitter}.md`
- Report file at `docs/sprints/001-revise-loop-convergence-report.md` containing the measurements required by the acceptance criteria
