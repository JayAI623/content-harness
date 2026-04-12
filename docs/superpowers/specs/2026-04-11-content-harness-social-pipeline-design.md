# Design: content-harness / social-pipeline

**Date**: 2026-04-11
**Status**: Design approved (brainstorming phase) — pending implementation plan
**Primary author**: Liu Zhe (with Claude Opus 4.6)

---

## 1. Goal & motivation

In the AI era, the bottleneck for an individual or small team is not reading the world — LLMs already consume and summarize at superhuman rates — but **writing to it**. The ability to be known by the world scales poorly with human effort. This project builds a general, reusable **content-harness framework** that turns a raw idea plus source materials into polished, platform-specific content via a `plan → generate → evaluate` loop, with simulated-audience feedback driving iterative quality improvement.

The framework is **persona-agnostic**. The same code serves:

- an AI-infrastructure engineer explaining systems to tech peers,
- a small-business owner marketing a product to consumers,
- a quant trader sharing systematic insights with practitioners,
- any future persona that follows the pattern `raw idea → base article → platform variants → evaluated output`.

All vertical-specific knowledge (topic, voice, audience, reference sources, success criteria) is **runtime configuration**, not hardcoded. Changing persona changes inputs, never code.

The first concrete domain built on the framework is `social-pipeline`, which produces content for Twitter (v1), then LinkedIn / Medium / 小红书 (v2+) from a shared base article, with multi-agent audience simulation gating the output.

## 2. Non-goals

- **Not a CMS**. We do not store the user's long-term content library; the asset pool holds research and style patterns only.
- **Not a scheduler**. When and how often to post is out of scope. The pipeline produces ready-to-post artifacts; the user (or a downstream process) handles posting.
- **Not a metrics dashboard**. `own_history` records past post metrics for the learning loop, but nothing is visualized.
- **Not an arbitrary LLM workflow engine**. `harness-core` is general within the space of "plan/generate/evaluate content pipelines", not "any agent task".
- **Not a drop-in replacement for the existing `harness/` project**. That codebase is polymarket-arbitrage-specific and stays untouched; we borrow the *pattern*, not the code.

## 3. Architectural principle: three-layer separation

The system has three layers, each with one clear purpose and a typed interface to its neighbour. No layer may reach across a boundary.

```
┌─ CONTENT LAYER (pluggable, domain-specific) ─────────────────┐
│   social-pipeline (this project)                            │
│                                                              │
│   Implements: HarnessDomain<TaskKind, State>                 │
│   Owns:                                                      │
│     • TaskKind enum + handlers                               │
│     • Domain schemas: Persona, Campaign, Piece, AssetPool    │
│     • Evaluator sub-agent mechanics                          │
│     • Prompt templates                                       │
│                                                              │
│   Future siblings (same layer, new packages):                │
│     • docs-pipeline, marketing-copy-pipeline, …              │
└────────────────────────┬─────────────────────────────────────┘
                         │ implements HarnessDomain<T, S>
                         ▼
┌─ ORCHESTRATION LAYER (domain-agnostic) ──────────────────────┐
│   harness-core                                               │
│                                                              │
│   Responsibilities:                                          │
│     1. Loop driver (plan → dispatch → eval → decide)         │
│     2. State owner (WorkPlan, deliverables, history)         │
│     3. Task dispatcher (DAG-aware)                           │
│     4. Budget enforcer (tokens / $ / iters / time)           │
│     5. Eval router (verdict → next action)                   │
│     6. Persistence (resumable runs)                          │
│     7. Retry & error handling                                │
│     8. Human-in-loop gates                                   │
│                                                              │
│   Does NOT: know about platforms, write prompts, call LLMs,  │
│   or own any business schema.                                │
└────────────────────────┬─────────────────────────────────────┘
                         │ tool contracts (stable)
                         ▼
┌─ INFRA LAYER (stable tools) ─────────────────────────────────┐
│   • @jackwener/opencli   — platform read/write adapters     │
│   • @anthropic-ai/sdk    — LLM client (with prompt cache)   │
│   • Asset store          — filesystem JSONL + blob          │
│   • Cost tracker         — per-call token/$ accounting      │
│   • Structured logger    — run-scoped JSON logs             │
└──────────────────────────────────────────────────────────────┘
```

**Boundary rules**:

1. `harness-core` never imports `social-pipeline` or any Infra package other than generic types. It talks to Content via the `HarnessDomain` interface and to Infra via a small set of injected interfaces (`LLMClient`, `AssetStore`, `Logger`, `Clock`).
2. `social-pipeline` never contains control flow. Handlers are pure functions of `(task, state, infra) → delta`.
3. Infra packages never know about the harness or the domain. They expose deterministic tool APIs.

The payoff: `harness-core` is reusable for *any* future content domain. Adding a `docs-pipeline` package requires zero changes to `harness-core` or `opencli`.

## 4. Data model

### 4.1 Persona (long-term configuration)

```ts
interface Persona {
  id: string;                         // stable identifier, used as asset-pool key
  identity: {
    name: string;                     // display name ("AI Infra Engineer Liu")
    one_line_bio: string;             // "I build AI infrastructure and share what I learn"
    long_bio: string;                 // multi-paragraph context / worldview / values
  };
  voice: {
    tone: string;                     // "conversational analytical", "punchy casual", ...
    point_of_view: string;            // "first-person practitioner", "teacher", ...
    vocabulary: {
      prefer: string[];               // signature words
      avoid: string[];                // words that feel off-brand or AI-smell-ish
    };
    example_phrases: string[];        // 3-5 signature sentences
  };
  domain: {
    primary_topics: string[];         // ["AI infrastructure", "agents", "tool design"]
    expertise_depth: "beginner" | "practitioner" | "expert";
    adjacent_topics: string[];        // cross-over areas
  };
  audience: {
    description: string;              // one paragraph
    pain_points: string[];
    sophistication: "layperson" | "practitioner" | "expert";
    evaluator_persona_ids: string[];  // pointers to audience sub-agents in asset pool
  };
  platforms: PlatformBinding[];       // per-platform handle + priority + role
  style_references: {
    emulate: AccountRef[];            // [{platform, handle, why}]
    avoid: AccountRef[];              // negative examples
  };
  success_metrics: {
    primary: "engagement" | "growth" | "clicks" | "citations";
    red_lines: string[];              // "never trade quality for reach"
  };
  asset_pool_id: string;              // usually equals persona.id
}

interface PlatformBinding {
  platform: "twitter" | "linkedin" | "medium" | "xiaohongshu";
  handle: string;
  priority: number;                   // 0..1, higher = preferred platform
  role: "primary" | "cross-post" | "syndicate";
}
```

Storage: `content-harness/data/personas/<persona_id>.yaml` (hand-editable).

### 4.2 Campaign (short-term goal under a Persona)

```ts
interface Campaign {
  id: string;
  persona_id: string;                 // parent
  goal: string;                       // "launch opencli v1.0"
  timeline: {
    start: ISO8601;
    end?: ISO8601;                    // null = open-ended
  };
  key_messages: string[];             // 3-5 messages to reinforce across pieces
  content_mix: Record<string, number>;// {thread: 5, article: 2, short: 10}
  overrides: {
    platform_weights?: Record<string, number>;  // downweight platforms for this campaign
    audience_additions?: string[];    // extra evaluator personas for this campaign
    voice_tweaks?: Partial<Persona["voice"]>;
  };
  success_criteria: string;           // campaign KPI, e.g., "500 GH stars"
}
```

Storage: `content-harness/data/campaigns/<campaign_id>.yaml`.

### 4.3 Piece (one content item)

```ts
interface Piece {
  id: string;
  campaign_id: string;                // parent
  persona_id: string;                 // resolved from campaign, cached for convenience

  input: {
    raw_materials: RawMaterial[];     // text / url / file / note
    intent: string;                   // one-liner: why this piece exists
  };

  state: "draft" | "refining" | "evaluating" | "ready" | "published";

  base_article?: {
    markdown: string;
    produced_at: ISO8601;
    source_refs: AssetRef[];          // which asset-pool items informed this article (§4.7)
  };

  platform_variants: PlatformVariant[];

  eval_history: EvalRound[];

  publish_refs?: PublishRef[];        // populated after publishing (v2+)
}

interface RawMaterial {
  id: string;                         // stable id so downstream refs can point here
  kind: "text" | "url" | "file" | "note";
  content: string;                    // for url/file: the resolved content
  origin: string;                     // path or url
}

interface PlatformVariant {
  platform: string;
  content: string;                    // final text/markdown
  media?: MediaRef[];                 // attached images/video (v2+)
  constraints_applied: string[];      // ["<= 280 chars", "hashtags <= 3"]
  inspired_by: AssetRef[];            // reference_posts / hot_topics the variant drew from (§4.7)
  style_patterns_applied: AssetRef[]; // style_patterns the refiner applied
  status: "drafting" | "pending_eval" | "accepted" | "rejected";
  eval_score?: number;                // 0..1, last eval round
  revision_count: number;
}

interface EvalRound {
  round: number;
  target: StateRef;                   // which variant/artifact was evaluated (§4.7)
  audience_feedback: AudienceFeedback[];
  aggregated_score: number;
  actionable_feedback: ActionableFeedback[];
  verdict: "accept" | "revise" | "abort";
}

interface AudienceFeedback {
  from: AssetRef;                     // kind: "evaluator_persona"
  understood: boolean;
  engagement_likelihood: number;      // 0..1
  ai_smell_score: number;             // 0..1, higher = more AI-smell
  depth_score: number;                // 0..1
  comments: string;
}

interface ActionableFeedback {
  from: AssetRef;                     // evaluator persona that raised this point
  category: "tone" | "structure" | "clarity" | "depth" | "ai_smell" | "other";
  text: string;
  targets: StateRef[];                // which artifacts need to change
  suggested_refs?: AssetRef[];        // refs the reviser should consult to fix it
}
```

Storage: `content-harness/runs/<run_id>/piece.json` (active) and archive after completion.

### 4.4 AssetPool (accumulated learning per Persona)

```ts
interface AssetPool {
  persona_id: string;
  reference_posts: ReferencePost[];
  style_patterns: StylePattern[];
  hot_topics: HotTopic[];
  evaluator_personas: EvaluatorPersona[];
  own_history: OwnPost[];
  voice_fingerprint?: VoiceFingerprint;
}

interface ReferencePost {
  id: string;
  platform: string;
  author: string;
  url: string;
  content: string;
  engagement: { likes?: number; shares?: number; comments?: number; views?: number };
  topic_tags: string[];
  collected_at: ISO8601;
  expires_at?: ISO8601;               // for TTL-based staleness
  source_query: string;               // the opencli search that found it
}

interface StylePattern {
  id: string;
  platform: string;
  pattern_type: "opening" | "transition" | "cta" | "tone" | "structure"
              | "vocab" | "emoji_use" | "hashtag_use";
  pattern_text: string;               // natural-language description
  example_ref_ids: string[];          // reference_posts that exemplify it
  extracted_at: ISO8601;
}

interface HotTopic {
  platform: string;
  topic: string;
  score: number;                      // 0..1
  observed_window: { from: ISO8601; to: ISO8601 };
  expires_at: ISO8601;
  source: string;
}

interface EvaluatorPersona {
  id: string;
  name: string;
  background: string;                 // multi-sentence persona
  interests: string[];
  pain_points: string[];
  reading_goals: string[];
  critic_style: "strict" | "balanced" | "generous";
  language: "en" | "zh" | "other";
}

interface OwnPost {
  piece_id: string;
  platform: string;
  url?: string;
  metrics: Record<string, number>;    // likes, rts, comments, views, ...
  posted_at: ISO8601;
}

interface VoiceFingerprint {
  vocab_histogram: Record<string, number>;
  sentence_rhythms: string;           // e.g., "short / short / long / question"
  typical_openings: string[];
  quirks: string[];
  extracted_from_piece_ids: string[];
  updated_at: ISO8601;
}
```

Storage layout:

```
content-harness/data/asset-pools/<persona_id>/
  reference_posts.jsonl
  style_patterns.jsonl
  hot_topics.jsonl
  evaluator_personas.yaml
  own_history.jsonl
  voice_fingerprint.json
  blobs/                              # full raw content for large refs
    <sha256>.txt
```

Scoping: defaults live at the persona level. A Campaign may append or override (see `Campaign.overrides`); Piece is read-only.

### 4.5 WorkPlan and Task (produced by Planner)

```ts
interface WorkPlan<TaskKind extends string> {
  plan_id: string;
  piece_id: string;
  tasks: Task<TaskKind>[];
  budget_estimate: { tokens: number; usd: number; iterations: number };
}

interface Task<TaskKind extends string> {
  id: string;
  kind: TaskKind;
  params: Record<string, unknown>;    // task-specific payload (non-ref params)
  deps: string[];                     // task ids that must complete first
  input_refs: AssetRef[];             // asset-pool refs the handler should read (§4.7)
  result_ref?: StateRef;              // where the handler's deliverable lives after success
  acceptance_criteria: string;        // natural-language description checked by evaluator
  gate_before: boolean;               // HITL: stop before dispatch
  gate_after: boolean;                // HITL: stop after completion, before verdict routing
  status: "pending" | "running" | "completed" | "failed" | "skipped";
}
```

### 4.6 Verdict (produced by Evaluator)

```ts
type Verdict =
  | { kind: "continue" }
  | { kind: "revise"; task_id: string; feedback: string }
  | { kind: "redirect"; reason: string }
  | { kind: "done" }
  | { kind: "abort"; reason: string };
```

### 4.7 Reference discipline (AssetRef / StateRef)

Handlers consume and produce **typed references**, not copies of data. This lets the agent trace why a variant looks the way it does (which refs shaped it), lets tasks be cached and replayed, and gives the evaluator a precise vocabulary for feedback. Every pointer in the data model is one of two kinds:

```ts
// Pointers into the persona's AssetPool (cross-run, accumulated knowledge)
type AssetRef =
  | { kind: "reference_post";    id: string }
  | { kind: "style_pattern";     id: string }
  | { kind: "hot_topic";         platform: string; topic: string }
  | { kind: "evaluator_persona"; id: string }
  | { kind: "own_post";          piece_id: string; platform: string }
  | { kind: "voice_fingerprint" };

// Pointers into the current run's state/deliverables (scoped to this run)
type StateRef =
  | { kind: "raw_material";     piece_id: string; material_id: string }
  | { kind: "base_article";     piece_id: string }
  | { kind: "platform_variant"; piece_id: string; platform: string; variant_idx: number }
  | { kind: "eval_round";       piece_id: string; round: number }
  | { kind: "deliverable";      path: string };                     // file under runs/<run_id>/deliverables/
```

**Contract for handlers**:

1. Read what the Planner gave you via `task.input_refs`. Dereference each ref through `infra.assets.resolve(pool, ref)` rather than pulling raw data in through `task.params`.
2. On success, write `result_ref` to the new artifact's StateRef and attach the AssetRefs you actually used into the artifact itself (`PlatformVariant.inspired_by`, `PlatformVariant.style_patterns_applied`, `Piece.base_article.source_refs`, …). "What did you use?" must always be answerable by reading the artifact.
3. Evaluator feedback uses refs both ways: `AudienceFeedback.from` points at the evaluator persona, `ActionableFeedback.targets` points at the artifact to change, and `ActionableFeedback.suggested_refs` points at what the reviser should read to fix it.

**Why this matters**: when an agent is asked "why does this tweet sound AI-ish?", it can walk `PlatformVariant.style_patterns_applied` → `StylePattern` records and see which patterns were invoked; when it runs a `revise` task, it knows exactly which AssetRefs to re-read and which StateRef to overwrite. Without typed refs every handler would re-invent ad-hoc pointer strings and the agent would have no stable way to follow them.

## 5. `harness-core` (Orchestration package)

### 5.1 Public API — the `HarnessDomain` interface

`harness-core` is parameterized over a domain the caller provides:

```ts
interface HarnessDomain<TaskKind extends string, State> {
  // Planning
  planInitial(ctx: PlanContext<State>): Promise<WorkPlan<TaskKind>>;
  replan(ctx: PlanContext<State>, reason: string): Promise<WorkPlan<TaskKind>>;

  // Task dispatch
  handlers: Record<TaskKind, TaskHandler<State>>;

  // Evaluation
  evaluate(state: State): Promise<Verdict>;
  isDone(state: State): boolean;

  // State management
  initState(input: unknown): State;
  serializeState(state: State): object;
  deserializeState(obj: object): State;
}

interface TaskHandler<State> {
  (task: Task<string>, state: State, infra: InfraBundle): Promise<Delta<State>>;
}

interface Delta<State> {
  kind: "success" | "failure";
  patches: StatePatch[];              // JSON-patch-style partial updates
  cost: CostAccounting;
  logs?: LogEntry[];
  error?: { message: string; retryable: boolean };
}
```

The only things `harness-core` imports from Infra are injected:

```ts
interface InfraBundle {
  llm: LLMClient;
  assets: AssetStore;
  logger: Logger;
  clock: Clock;
  // Note: opencli is NOT in InfraBundle — social-pipeline imports it directly
  //       because it is domain-specific to which platforms we care about.
}
```

`RunConfig` controls the loop's behaviour and is supplied by the caller:

```ts
interface RunConfig {
  run_id: string;                     // stable identifier for the run directory
  run_root: string;                   // path to runs/ root
  budget: BudgetLimits;
  retry: { max_attempts: number; backoff_ms: number };
  gates: {
    post_plan: boolean;
    pre_publish: boolean;
  };
  gate_resolver: GateResolver;
  resume_from?: string;               // run_id to resume; optional
  thresholds: {
    eval_pass: number;                // default 0.7
    ai_smell_max: number;             // default 0.3
    depth_min: number;                // default 0.5
  };
  max_revisions: number;              // default 3
}

type GateEvent<TK extends string, S> =
  | { kind: "post_plan"; plan: WorkPlan<TK> }
  | { kind: "pre_publish"; state: S }
  | { kind: "task_gate_before"; task: Task<TK> }
  | { kind: "task_gate_after"; task: Task<TK>; delta: Delta<S> };

type GateDecision = "approve" | "reject";

interface GateResolver {
  <TK extends string, S>(event: GateEvent<TK, S>): Promise<GateDecision>;
}
```

### 5.2 Loop semantics

```ts
async function run<TK extends string, S>(
  domain: HarnessDomain<TK, S>,
  input: unknown,
  config: RunConfig,
  infra: InfraBundle,
): Promise<RunResult<S>> {
  let state = domain.initState(input);
  let plan = await domain.planInitial({ state, config });
  const budget = new Budget(config.budget);
  const run_dir = await persist.createRun(config.run_id);

  await persist.snapshot(run_dir, { state, plan, budget: budget.snapshot() });

  // Human gate: post-plan
  if (config.gates.post_plan) {
    await config.gate_resolver({ kind: "post_plan", plan });
  }

  while (!domain.isDone(state) && !budget.exhausted()) {
    const task = selectNextRunnable(plan, state);
    if (!task) { await handleStuck(state, plan, domain); continue; }

    if (task.gate_before) {
      const decision = await config.gate_resolver({ kind: "task_gate_before", task });
      if (decision === "reject") { plan = markRejected(plan, task); continue; }
    }

    let delta: Delta<S>;
    try {
      delta = await runWithRetry(domain.handlers[task.kind], task, state, infra, config.retry);
    } catch (err) {
      delta = { kind: "failure", patches: [], cost: zeroCost, error: { message: String(err), retryable: false } };
    }

    state = applyDelta(state, delta);
    budget.charge(delta.cost);
    await persist.appendEvent(run_dir, { task, delta });
    await persist.snapshot(run_dir, { state, plan, budget: budget.snapshot() });

    if (task.gate_after) {
      const decision = await config.gate_resolver({ kind: "task_gate_after", task, delta });
      if (decision === "reject") {
        plan = markRevise(plan, task.id, "user rejected at post-task gate");
        continue;
      }
    }

    const verdict = await domain.evaluate(state);
    switch (verdict.kind) {
      case "continue": break;
      case "revise":   plan = markRevise(plan, verdict.task_id, verdict.feedback); break;
      case "redirect": plan = await domain.replan({ state, config }, verdict.reason); break;
      case "done":     return { ok: true, state, budget: budget.snapshot() };
      case "abort":    return { ok: false, state, reason: verdict.reason, budget: budget.snapshot() };
    }
  }

  return { ok: budget.exhausted() ? false : true, state, budget: budget.snapshot() };
}
```

### 5.3 State, persistence, resumability

Every loop iteration writes two artifacts to the run directory:

```
content-harness/runs/<run_id>/
  manifest.json              # run metadata (started_at, config, domain_id)
  events.jsonl               # append-only log of {task, delta} pairs
  state/
    state-0.json             # snapshot after init
    state-1.json             # snapshot after task 1
    ...
  plan/
    plan-0.json
    plan-1.json              # only when plan changes
    ...
  budget.json                # rolling snapshot
  deliverables/              # files the handlers wrote (e.g., distilled patterns)
  logs/
    run.jsonl                # structured logs
```

Resuming: `run` can take a `resume_from: run_id` option that reads the latest `state-N.json` and `plan-N.json` and continues the loop.

### 5.4 Budget model

```ts
interface BudgetLimits {
  max_tokens?: number;
  max_usd?: number;
  max_iterations?: number;
  max_wall_seconds?: number;
}
```

Any limit hit → `budget.exhausted()` becomes true; loop returns with `ok: false` and a persisted state the user can inspect or resume from.

Default v1 limits (overridable in `RunConfig.budget`):

| Limit | Default | Reason |
|-------|---------|--------|
| `max_tokens` | 500_000 | enough for ~15 LLM turns including eval sub-agents |
| `max_usd` | 5.00 | conservative guardrail while developing |
| `max_iterations` | 40 | at most ~5 platform variants × 3 revisions + overhead |
| `max_wall_seconds` | 1800 | 30 minutes wall-clock cap |

### 5.5 Human-in-loop gates

Two gate kinds:

1. **Structural gates** (configured at run level): `post_plan`, `pre_publish` (future). The loop checks `config.gates.<name>` at well-known points and calls `config.gate_resolver` if ON.
2. **Task gates** (configured per task by the Planner): any task may set `gate_before: true` (loop stops before dispatch) or `gate_after: true` (loop stops after task runs, with the fresh `delta` visible to the gate_resolver).

`gate_resolver` is a caller-provided async callback. Invocation kinds: `post_plan`, `pre_publish`, `task_gate_before`, `task_gate_after`. In CLI mode it prompts the terminal; in headless mode it can auto-approve or reject based on rules.

For MVP v1:
- `post_plan` gate default **ON**
- Task gates: `refine_variant` tasks carry `gate_after: true` (this is how "post-variant" gets enforced — the loop pauses after a variant is produced, before the evaluator runs, so the user reviews the actual output)
- `pre_publish` gate default ON but no-op because v1 has no publish step

### 5.6 Retry & error handling

`runWithRetry` retries `config.retry.max_attempts` times on retryable errors (network, transient LLM errors). Non-retryable errors (handler threw `Error` with `cause: "permanent"`) produce a `Delta` of kind `failure` which the evaluator may promote to `revise` (redo with feedback) or `redirect` (replan).

### 5.7 What `harness-core` never does

- Never writes a prompt
- Never imports `@jackwener/opencli`
- Never knows the string "twitter"
- Never defines `Persona`, `Campaign`, or any business schema
- Never calls `@anthropic-ai/sdk` directly; it calls `infra.llm`

## 6. `social-pipeline` (Content package)

### 6.1 TaskKind enum

```ts
type SocialTaskKind =
  | "research_refs"
  | "research_trends"
  | "distill_style"
  | "draft_base"
  | "refine_variant"
  | "eval_variant"
  | "revise";
```

### 6.2 Handlers (one file per kind)

```
src/handlers/
  research_refs.ts       # 0 LLM; calls opencli search
  research_trends.ts     # 0 LLM; calls opencli trending
  distill_style.ts       # LLM (cheap model)
  draft_base.ts          # LLM (main model)
  refine_variant.ts      # LLM (main model)
  eval_variant.ts        # LLM (cheap model, N calls — one per evaluator persona)
  revise.ts              # LLM (main model)
```

Each handler is a pure async function `(task, state, infra) → Delta`. Side effects are limited to:

- Reading/writing `AssetStore` via `infra.assets`
- Calling LLM via `infra.llm`
- Calling opencli by importing `@jackwener/opencli` directly (allowed: we're in the Content layer)

Every handler has a matching `handlers/<kind>.test.ts` with:

1. A fixture-based test using recorded opencli responses
2. A mocked-LLM test asserting prompt structure
3. A failure-mode test asserting error propagation

### 6.3 Planner logic (`domain.ts → planInitial`)

```
input: persona, campaign, piece, asset_pool_index
procedure:
  tasks = []
  for each platform in persona.platforms (where priority > 0):
    if asset_pool.reference_posts for (platform, piece.topic) is missing or stale:
      tasks += research_refs(platform, piece.topic)
    if asset_pool.hot_topics for platform is missing or stale:
      tasks += research_trends(platform)
    if asset_pool.style_patterns for platform is stale:
      tasks += distill_style(platform) [deps: research_refs]

  tasks += draft_base()       [deps: all research + distill]

  for each platform:
    tasks += refine_variant(platform)   [deps: draft_base, distill_style(platform)]
    tasks += eval_variant(platform)     [deps: refine_variant(platform)]
    # revise tasks are inserted dynamically on "revise" verdicts

  return WorkPlan(tasks, budget_estimate)
```

**MVP v1 simplification**: the v1 planner only emits `research_refs`, `draft_base`, `refine_variant`, `eval_variant`, and (dynamic) `revise` — it skips `research_trends` and `distill_style`. Style guidance is inlined into the `refine_variant` prompt in v1; v2 promotes it to a `distill_style` task as the asset pool grows.

`replan` is called on `redirect` verdicts and can shrink / expand the DAG (e.g., drop a struggling platform, add more research).

### 6.4 Evaluator: audience simulation

`domain.evaluate` is called after every task. For most task kinds it simply checks `task.status === completed` and returns `{kind: "continue"}`. For `eval_variant` tasks it consults the fresh `EvalRound` written by the handler:

```
aggregated = mean(audience_feedback.engagement_likelihood)  # equal weights by default;
                                                            # Persona may set per-persona weights
ai_smell   = max(audience_feedback.ai_smell_score)   # worst case
depth      = mean(audience_feedback.depth_score)
passed     = aggregated ≥ 0.7 AND ai_smell ≤ 0.3 AND depth ≥ 0.5

if passed:
  mark variant "accepted"; continue
else if revision_count < config.max_revisions:         # default 3
  revise with deduped, persona-attributed actionable feedback
else:
  abort this variant (evaluator returns `redirect` with reason)
```

Default thresholds (`0.7 / 0.3 / 0.5`) and `max_revisions: 3` are stored in `RunConfig` and overridable per run.

`eval_variant.ts` is where sub-agent simulation actually runs. For each `evaluator_persona` attached to the Persona:

1. Build a persona-specific system prompt: "You are {name}. Background: {background}. You are reading the following post and giving honest reactions. Answer the 5 questions below."
2. Call `infra.llm.complete(...)` with the variant content
3. Parse structured response into `AudienceFeedback`

All calls run in parallel (`Promise.all`).

### 6.5 LLM model tiers

Two tiers configured via `infra.llm`:

- **main**: `claude-opus-4-6` — used by `draft_base`, `refine_variant`, `revise`
- **cheap**: `claude-haiku-4-5-20251001` — used by `distill_style`, `eval_variant`

Prompt cache (`cache_control: ephemeral`) is used for static persona context that appears in multiple calls within a single run.

### 6.6 HITL gate defaults (MVP v1)

| Gate | Default | Mechanism |
|------|---------|-----------|
| pre-plan (A) | OFF | n/a |
| post-plan (B) | **ON** | structural gate in `run` |
| post-base (C) | OFF | n/a |
| post-variant (D) | **ON** | `refine_variant` tasks have `gate_after: true` — loop stops with the freshly written variant in `delta` |
| pre-publish (E) | **ON** but no-op (no publish in v1) | structural gate |

## 7. Infra layer

### 7.1 `@jackwener/opencli` (existing)

Imported directly by handlers that need platform access. No wrapper — the harness does not need to abstract over opencli because social-pipeline's handlers already know which platform they are targeting. Examples used in v1:

- `opencli twitter search --query "..."` → reference_posts
- `opencli twitter trending` → hot_topics

### 7.2 LLM client

Thin wrapper around `@anthropic-ai/sdk` exposing `complete({ model, system, messages, cache_control, max_tokens })`. Responsibilities:

- Route `main` vs `cheap` tier
- Apply prompt cache on static system blocks
- Emit cost events (in + out tokens, $ estimate)
- Retry on `429` / `529` with exponential backoff

Lives in `harness-core/src/infra/llm.ts` so it's shared across domains.

### 7.3 Asset store

Filesystem JSONL + blob implementation under `content-harness/data/asset-pools/`. API:

```ts
interface AssetStore {
  append<T>(pool: string, bucket: string, records: T[]): Promise<void>;
  query<T>(pool: string, bucket: string, filter: AssetFilter): Promise<T[]>;
  resolve<T>(pool: string, ref: AssetRef): Promise<T | null>;     // dereference any AssetRef — handlers' main entry point
  putBlob(pool: string, key: string, bytes: Uint8Array): Promise<string>;
  getBlob(pool: string, key: string): Promise<Uint8Array | null>;
  ttlCheck(pool: string, bucket: string, now: Date): Promise<StalenessReport>;
}
```

TTL: configurable per bucket (e.g., `hot_topics: 24h`, `reference_posts: 30d`, `style_patterns: 7d`).

### 7.4 Cost tracker

Collects `CostAccounting` deltas from every handler and exposes them to `Budget`. Emits structured cost events to logs.

### 7.5 Structured logger

JSON-to-stdout-and-file, one line per event, tagged with `run_id`, `task_id`, `kind`. Consumed by the persistence layer for `events.jsonl` and by humans for debugging.

## 8. MVP v1 scope

### 8.1 In scope

- `harness-core` minimum viable:
  - `planInitial` / `replan` / loop driver
  - `Budget` with token + iteration limits
  - Filesystem persistence with resume capability
  - Structural post-plan gate; task-level gates
  - Retry (max 2 attempts, fixed backoff)
- `social-pipeline` minimum viable:
  - Twitter only (opencli twitter has the richest adapter set)
  - TaskKinds: `research_refs`, `draft_base`, `refine_variant`, `eval_variant`, `revise`
  - Omitted in v1: `research_trends`, `distill_style` (hardcode a minimal style prompt for Twitter)
  - 2–3 `evaluator_personas` hardcoded for one test Persona (the AI-infra-engineer persona described in §1)
  - No publishing — handlers write final variant to stdout and to `runs/<run_id>/deliverables/twitter_variant.md`
- One worked example: an AI-infra-engineer Persona, one Campaign ("Q2 infra insights"), one Piece ("what I learned debugging the harness loop"), runs end to end, produces a Twitter thread that clears the eval threshold.

### 8.2 Out of scope for v1 (deferred to v2+)

- LinkedIn / Medium / 小红书 handlers
- `research_trends` and `distill_style` as separate tasks (use inline prompting in v1)
- Publishing via opencli
- Voice fingerprint extraction
- `own_history` feedback loop
- Scheduled runs, cron, webhooks
- Multi-run asset pool sharing across pieces (v1 uses fresh pool per run for simplicity)
- Media attachment handling (images, video)

### 8.3 Definition of done for v1

```
Given:   a Persona yaml, a Campaign yaml, a Piece yaml (raw text + intent)
When:    I run `pnpm --filter social-pipeline run dev -- \
             --persona ./data/personas/ai-infra.yaml \
             --campaign ./data/campaigns/q2-infra.yaml \
             --piece ./data/pieces/harness-debug.yaml`
Then:    after approving the plan at the post-plan gate,
         after approving the variant at the post-variant gate,
         I get a Twitter-ready variant written to runs/<run_id>/deliverables/twitter_variant.md
         whose `aggregated_score ≥ 0.7` and `ai_smell_score ≤ 0.3`,
         with `events.jsonl` fully replayable.
```

## 9. Testing strategy (TDD, vitest)

### 9.1 Principles

- Every package uses vitest.
- Every handler has its own test file (`<handler>.test.ts`) written before the handler implementation.
- Opencli and LLM calls are stubbed in handler unit tests using fixture files committed to `tests/fixtures/`.
- Golden tests compare prompt outputs to committed expectations to catch prompt drift.

### 9.2 `harness-core` tests

- **Planner**: given a fake domain, `planInitial` is called and returns a plan. Loop dispatches tasks in dependency order.
- **Loop dispatch**: DAG respected; cycles detected; stuck detection raises.
- **Budget**: loop stops when any limit hits; persisted state is resumable.
- **Verdict routing**: each verdict kind drives the expected state transition.
- **Persistence**: snapshot + resume round-trip is lossless.
- **HITL gate**: `gate_resolver` is called at the right moments; rejection marks the task rejected.
- **Retry**: transient errors retried up to `max_attempts`; permanent errors not retried.

### 9.3 `social-pipeline` tests

- **Per-handler unit tests** with fixtures:
  - `research_refs.test.ts`: fed a fake opencli client, asserts correct search parameters and correct writes to the asset pool.
  - `draft_base.test.ts`: fed a mocked LLM, asserts prompt structure includes persona voice and raw materials, and that the output is written to `state.piece.base_article`.
  - `refine_variant.test.ts`: asserts constraint strings are applied, output length respects platform limits.
  - `eval_variant.test.ts`: fed a mocked LLM returning canned `AudienceFeedback`, asserts aggregation math and correct `EvalRound` structure.
  - `revise.test.ts`: asserts feedback is threaded into the next draft.
- **Integration test**: MVP v1 end-to-end run with a tiny test Persona, a fake opencli, a fake LLM. Asserts `deliverables/twitter_variant.md` exists and matches a golden file.

### 9.4 Fixture pattern

Follow opencli's convention: record real responses once with a helper script (`pnpm record-fixtures`), commit the sanitized JSON to `tests/fixtures/`, replay in tests. Rotate fixtures when the platform API breaks.

## 10. Repo layout

```
AI项目/
  opencli/                                  ← unchanged
  content-harness/                          ← NEW monorepo
    pnpm-workspace.yaml
    package.json                            # root scripts (dev/test/lint)
    tsconfig.base.json
    .gitignore                              # runs/, data/ (except fixtures)
    README.md
    docs/
      superpowers/
        specs/
          2026-04-11-content-harness-social-pipeline-design.md  ← this file
    packages/
      harness-core/
        package.json                        # @content-harness/core
        tsconfig.json
        src/
          index.ts                          # barrel
          types.ts                          # HarnessDomain, Task, Verdict, Delta, ...
          planner.ts
          generator.ts                      # task dispatch wrapper
          evaluator.ts                      # verdict routing helpers
          loop.ts
          budget.ts
          persistence.ts
          retry.ts
          gates.ts
          infra/
            llm.ts                          # LLM client interface + impl
            logger.ts
            clock.ts
        tests/
          planner.test.ts
          loop.test.ts
          budget.test.ts
          persistence.test.ts
          gates.test.ts
          retry.test.ts
          fixtures/
      social-pipeline/
        package.json                        # @content-harness/social
        tsconfig.json
        src/
          index.ts
          domain.ts                         # implements HarnessDomain
          schemas/
            persona.ts
            campaign.ts
            piece.ts
            asset-pool.ts
          handlers/
            research_refs.ts
            draft_base.ts
            refine_variant.ts
            eval_variant.ts
            revise.ts
          eval/
            personas.ts                     # default evaluator personas for v1
            simulator.ts                    # sub-agent dispatch
            aggregator.ts                   # score math
          asset-store.ts                    # filesystem impl
        tests/
          handlers/
            research_refs.test.ts
            draft_base.test.ts
            refine_variant.test.ts
            eval_variant.test.ts
            revise.test.ts
          integration/
            e2e.test.ts                     # MVP v1 end-to-end
          fixtures/
        bin/
          run.ts                            # CLI entry point
    data/                                   # runtime; gitignored except fixtures
      personas/
        ai-infra-engineer-liu.yaml          # example persona (v1 test target)
        real-estate-agent-sarah.yaml        # example persona (demonstrates generality)
      campaigns/
      pieces/
      asset-pools/
    runs/                                   # gitignored
```

## 11. Open questions / future work

1. **Sub-agent isolation**: v1 runs evaluator sub-agents as in-process LLM calls. If a persona grows to need genuinely isolated context or their own tool access, we may need process-level or Claude Agent SDK-based isolation.
2. **Research reuse across pieces**: v1 scopes the asset pool per persona but doesn't share knowledge from one Piece's research with subsequent Pieces. v2 should add asset-pool-level TTL + query-reuse.
3. **Voice fingerprint**: the schema is defined but not populated in v1. When the user has enough past posts, we should add a task that re-extracts the fingerprint and uses it to bias `draft_base`.
4. **Metrics feedback loop**: `own_history` metrics are defined but v1 has no ingestion path. v2 needs a `sync_metrics` task that polls opencli for the user's recent posts and updates `own_history`.
5. **Multi-language evaluator personas**: v1 runs in English for Twitter. When 小红书 is added, evaluator personas must support Chinese prompting.
6. **Parallel task execution**: v1 runs tasks serially. `research_refs` across platforms could run in parallel; worth revisiting after v1 ships.
7. **Cost transparency surface**: v1 logs costs; v2 could surface a per-run cost report at the end.
8. **Rollbacks**: if publishing is wired up later, we need a "retract / edit" path that uses opencli's post-modification adapters.

---

## 12. Example personas

Two worked example Personas demonstrating the framework's persona-agnostic range. Both live under `content-harness/data/personas/*.yaml` and are loaded at runtime with zero code changes. The AI infra engineer is the v1 test target; the real estate agent exists to prove the framework bends to a very different domain, audience, and platform mix.

### 12.1 `ai-infra-engineer-liu.yaml` — v1 test target

```yaml
id: ai-infra-engineer-liu
identity:
  name: Liu Zhe — AI Infra Engineer
  one_line_bio: I build AI infrastructure and share what I learn debugging it.
  long_bio: |
    I work on the systems underneath LLM applications — harness loops,
    tool protocols, state machines, cost accounting. I write about the
    unglamorous parts of making AI actually useful: retries, budget limits,
    the subtle ways observability saves you at 2am.
voice:
  tone: conversational analytical
  point_of_view: first-person practitioner
  vocabulary:
    prefer: [harness, loop, budget, verdict, state, delta, handler, retry]
    avoid: [revolutionize, game-changer, paradigm, unlock, unleash]
  example_phrases:
    - "We hit this bug last week and here's what I learned."
    - "The interesting part wasn't the model — it was the state machine."
    - "Three retries in, I finally saw why the token count was wrong."
domain:
  primary_topics: [AI infrastructure, agent frameworks, tool design, cost engineering]
  expertise_depth: practitioner
  adjacent_topics: [prompt caching, evals, observability, TDD with LLMs]
audience:
  description: |
    Engineers building LLM-powered systems in production — not prompt hobbyists,
    but people who own pagers and SLAs.
  pain_points:
    - LLM flakiness in production
    - hard-to-debug agent loops
    - surprise costs
    - evals that do not translate to real behavior
  sophistication: practitioner
  evaluator_persona_ids:
    - senior-ai-eng-skeptical
    - startup-cto-buying-time
    - agent-framework-maintainer
platforms:
  - { platform: twitter,  handle: liuzhe_ai,  priority: 1.0, role: primary }
  - { platform: linkedin, handle: liu-zhe-ai, priority: 0.6, role: cross-post }
  - { platform: medium,   handle: liuzhe,     priority: 0.3, role: syndicate }
style_references:
  emulate:
    - { platform: twitter, handle: eugeneyan, why: "tight technical threads with concrete numbers" }
    - { platform: twitter, handle: simonw,    why: "clear plain-English explanations of complex systems" }
  avoid:
    - { platform: twitter, handle: ai_hype_account, why: "generic hype without substance" }
success_metrics:
  primary: engagement
  red_lines:
    - never trade depth for reach
    - never fake a demo
    - always show the failure mode alongside the fix
asset_pool_id: ai-infra-engineer-liu
```

### 12.2 `real-estate-agent-sarah.yaml` — generality demo

A very different Persona: Chinese-first, xiaohongshu-primary, consumer audience, expert-in-domain but speaking to practitioners. Shows that the framework does not bake in English, technical tone, or Twitter-shaped outputs.

```yaml
id: real-estate-agent-sarah
identity:
  name: Sarah Chen — 湾区房产经纪人
  one_line_bio: 帮湾区家庭找到真正合适的房子，10 年经验。
  long_bio: |
    我在湾区做房产经纪 10 年，专注 Palo Alto、Mountain View、Cupertino
    这几个学区城市。我相信每个家庭都应该找到"真正适合自己"的房子，
    而不是被推销最贵的。每次看房我都亲自下地下室、爬阁楼、查三份 comps。
voice:
  tone: warm professional, data-backed storytelling
  point_of_view: trusted advisor who has walked hundreds of families home
  vocabulary:
    prefer: [学区, 通勤, comps, walkthrough, lifestyle fit, 房屋结构, 首付比例]
    avoid: [绝佳机会, 千载难逢, 火爆, 内幕, 独家渠道, 价格必涨]
  example_phrases:
    - "昨天有 3 组家庭看了这套房，我记录了他们最在意的 5 个点。"
    - "我花了一上午在地下室检查水管和加热器，这里是我发现的。"
    - "别被 list price 锚定。这是同一街区最近 5 套 comps 的实际成交价。"
domain:
  primary_topics:
    - Bay Area 房市趋势
    - 学区分析
    - 首次购房指南
    - Home inspection 重点
    - Negotiation strategy
  expertise_depth: expert
  adjacent_topics: [mortgage rates, property tax, 装修 ROI, 社区 lifestyle]
audience:
  description: |
    35–55 岁湾区科技行业家庭，双职工，孩子 0–12 岁，正在考虑第一套或换房。
    对学区敏感，看重通勤和生活平衡。
  pain_points:
    - 价格高，预算紧张
    - 不知道哪个学区真的好
    - 担心买在最高点
    - 不知道怎么区分 marketing fluff 和真价值
  sophistication: practitioner
  evaluator_persona_ids:
    - first-time-buyer-tech-couple
    - upgrade-family-with-kids
    - cautious-cash-buyer
platforms:
  - { platform: xiaohongshu, handle: sarah_bayarea_homes, priority: 1.0, role: primary }
  - { platform: linkedin,    handle: sarah-chen-realtor,  priority: 0.6, role: cross-post }
  - { platform: twitter,     handle: sarahchenRE,         priority: 0.3, role: syndicate }
style_references:
  emulate:
    - { platform: xiaohongshu, handle: bayarea_home_hunter,    why: "数据驱动 + 生活场景化" }
    - { platform: linkedin,    handle: top-realtor-west-coast, why: "学区分析深度" }
  avoid:
    - { platform: xiaohongshu, handle: pushy_realtor_xxx, why: "虚假紧迫感、标题党" }
success_metrics:
  primary: clicks
  red_lines:
    - 从不制造虚假紧迫感
    - 总是披露 listing 是我自己的还是第三方分析
    - 从不承诺具体的价格预测
asset_pool_id: real-estate-agent-sarah
```

**What these two Personas exercise in the framework**:

| Dimension | AI infra engineer | Real estate agent |
|-----------|-------------------|--------------------|
| Primary language | English | Chinese (mixed zh/en) |
| Primary platform | Twitter | Xiaohongshu |
| Audience | B2B practitioners | B2C families |
| Success metric | engagement | clicks |
| Evaluator personas | technical skeptics | buyer archetypes |
| Voice | analytical | warm advisory |
| `style_references.emulate` targets | English tech Twitter | Chinese xiaohongshu realtors |

If the same `harness-core` can drive both to passing eval scores with zero code changes, the layer separation in §3 is doing its job.

---

**End of spec.** Implementation plan to be produced via the `writing-plans` skill after user review of this document.
