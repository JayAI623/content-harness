# 设计：content-harness / social-pipeline

**日期**：2026-04-11
**状态**：设计已批准（brainstorming 阶段）— 待 implementation plan
**主要作者**：Liu Zhe（与 Claude Opus 4.6 协作）

---

## 1. 目标与动机

AI 时代，个人或小团队的瓶颈不在于"读世界"——LLM 消化和总结信息的速度已经超人——而在于**向世界表达**。"被世界看到"这件事很难靠人力堆出来。本项目构建一个通用的、可复用的 **content-harness 框架**：通过 `plan → generate → evaluate` 循环，把一个原始 idea 加上 source materials 打磨成针对各平台的成品内容，由"模拟受众反馈"驱动迭代优化质量。

这个框架是 **persona 无关的**。同一套代码可以服务于：

- AI infra 工程师向技术同行解释系统
- small business owner 向消费者营销产品
- 量化交易者向同行分享系统性洞察
- 未来任何符合 `原始 idea → base article → 平台 variants → 评价后输出` 模式的 persona

所有垂直领域知识（主题、voice、audience、参考来源、成功标准）都是**运行时配置**，而非硬编码。切换 persona 改的是输入，不改代码。

框架上第一个具体的 domain 是 `social-pipeline`，从一份 base article 产出 Twitter（v1）内容，未来扩展到 LinkedIn / Medium / 小红书（v2+），由多 agent 模拟受众评价把关输出。

## 2. 非目标（Non-goals）

- **不是 CMS**。我们不存用户的长期内容库；asset pool 只存 research 和 style patterns。
- **不是排期器**。什么时候发、多久发一次不在范围内。Pipeline 产出可直接发布的工件，发布动作交给用户或下游流程。
- **不是数据看板**。`own_history` 记录过去帖子的 metrics 用于学习回路，但不做可视化。
- **不是通用 LLM workflow 引擎**。`harness-core` 在"plan/generate/evaluate 内容 pipeline"这个空间里是通用的，而不是"任意 agent 任务"。
- **不是现有 `harness/` 项目的替换**。那个代码库是 polymarket-arbitrage 专用的，保持不动；我们借用*模式*，不借用代码。

## 3. 架构原则：三层分离

系统分三层，每层有一个清晰目的和到相邻层的类型化接口。任何层都不能越界访问。

```
┌─ 内容层（可插拔，domain 专用）──────────────────────────────┐
│   social-pipeline（本项目）                                │
│                                                            │
│   实现：HarnessDomain<TaskKind, State>                     │
│   拥有：                                                   │
│     • TaskKind 枚举 + handlers                             │
│     • Domain schemas：Persona, Campaign, Piece, AssetPool  │
│     • Evaluator 子 agent 机制                              │
│     • Prompt 模板                                          │
│                                                            │
│   未来的同层兄弟（同一层，新 package）：                    │
│     • docs-pipeline, marketing-copy-pipeline, …            │
└────────────────────────┬───────────────────────────────────┘
                         │ 实现 HarnessDomain<T, S>
                         ▼
┌─ 编排层（domain 无关）──────────────────────────────────────┐
│   harness-core                                             │
│                                                            │
│   职责：                                                    │
│     1. 循环驱动（plan → dispatch → eval → decide）          │
│     2. 状态管理（WorkPlan, deliverables, history）          │
│     3. Task dispatcher（感知 DAG）                          │
│     4. Budget 执行（tokens / $ / 迭代 / 时间）               │
│     5. Eval 路由（verdict → 下一步动作）                    │
│     6. Persistence（可恢复的 run）                          │
│     7. Retry 与错误处理                                     │
│     8. Human-in-loop gate                                  │
│                                                            │
│   不做：不知道平台、不写 prompt、不直接调 LLM、              │
│          不拥有任何业务 schema                              │
└────────────────────────┬───────────────────────────────────┘
                         │ tool 合约（稳定）
                         ▼
┌─ Infra 层（稳定工具）───────────────────────────────────────┐
│   • @jackwener/opencli   — 平台读/写适配器                  │
│   • @anthropic-ai/sdk    — LLM 客户端（带 prompt cache）    │
│   • Asset store          — 文件系统 JSONL + blob            │
│   • Cost tracker         — 每次调用 token/$ 记账            │
│   • Structured logger    — run 范围的 JSON 日志             │
└────────────────────────────────────────────────────────────┘
```

**边界规则**：

1. `harness-core` 不 import `social-pipeline` 或任何 Infra package（除了通用类型）。它通过 `HarnessDomain` 接口和内容层说话，通过一组被注入的小接口（`LLMClient`、`AssetStore`、`Logger`、`Clock`）和 Infra 层说话。
2. `social-pipeline` 不包含控制流。Handlers 是 `(task, state, infra) → delta` 的纯函数。
3. Infra package 不知道 harness 或 domain 的存在。它们暴露确定性的 tool API。

**收益**：`harness-core` 对*任何*未来的内容 domain 都可复用。新加一个 `docs-pipeline` package 不需要改 `harness-core` 或 `opencli` 任何一行代码。

## 4. 数据模型

### 4.1 Persona（长期配置）

```ts
interface Persona {
  id: string;                         // 稳定标识，用作 asset pool 的 key
  identity: {
    name: string;                     // 显示名（"AI Infra Engineer Liu"）
    one_line_bio: string;             // "I build AI infrastructure and share what I learn"
    long_bio: string;                 // 多段落 context / 世界观 / 价值观
  };
  voice: {
    tone: string;                     // "conversational analytical", "punchy casual", ...
    point_of_view: string;            // "first-person practitioner", "teacher", ...
    vocabulary: {
      prefer: string[];               // 招牌词
      avoid: string[];                // 不符合品牌或有 AI 味的词
    };
    example_phrases: string[];        // 3-5 条招牌句子
  };
  domain: {
    primary_topics: string[];         // ["AI infrastructure", "agents", "tool design"]
    expertise_depth: "beginner" | "practitioner" | "expert";
    adjacent_topics: string[];        // 相邻交叉领域
  };
  audience: {
    description: string;              // 一段话描述
    pain_points: string[];
    sophistication: "layperson" | "practitioner" | "expert";
    evaluator_persona_ids: string[];  // 指向 asset pool 里的 audience 子 agent
  };
  platforms: PlatformBinding[];       // 每个平台的 handle + 优先级 + 角色
  style_references: {
    emulate: AccountRef[];            // [{platform, handle, why}]
    avoid: AccountRef[];              // 反面例子
  };
  success_metrics: {
    primary: "engagement" | "growth" | "clicks" | "citations";
    red_lines: string[];              // "never trade quality for reach"
  };
  asset_pool_id: string;              // 通常等于 persona.id
}

interface PlatformBinding {
  platform: "twitter" | "linkedin" | "medium" | "xiaohongshu";
  handle: string;
  priority: number;                   // 0..1，越大越偏好
  role: "primary" | "cross-post" | "syndicate";
}
```

存储：`content-harness/data/personas/<persona_id>.yaml`（可手动编辑）。

### 4.2 Campaign（Persona 下的短期目标）

```ts
interface Campaign {
  id: string;
  persona_id: string;                 // 父引用
  goal: string;                       // "launch opencli v1.0"
  timeline: {
    start: ISO8601;
    end?: ISO8601;                    // null = 开放式
  };
  key_messages: string[];             // 3-5 条跨 piece 强化的 message
  content_mix: Record<string, number>;// {thread: 5, article: 2, short: 10}
  overrides: {
    platform_weights?: Record<string, number>;  // 为本 campaign 调低某些平台权重
    audience_additions?: string[];    // 为本 campaign 增加的 evaluator personas
    voice_tweaks?: Partial<Persona["voice"]>;
  };
  success_criteria: string;           // Campaign KPI，比如 "500 GH stars"
}
```

存储：`content-harness/data/campaigns/<campaign_id>.yaml`。

### 4.3 Piece（一条内容）

```ts
interface Piece {
  id: string;
  campaign_id: string;                // 父引用
  persona_id: string;                 // 从 campaign 解析出的，为了方便缓存一份

  input: {
    raw_materials: RawMaterial[];     // text / url / file / note
    intent: string;                   // 一句话：为什么有这条 piece
  };

  state: "draft" | "refining" | "evaluating" | "ready" | "published";

  base_article?: {
    markdown: string;
    produced_at: ISO8601;
    source_refs: AssetRef[];          // 本文参考的 asset pool 条目（见 §4.7）
  };

  platform_variants: PlatformVariant[];

  eval_history: EvalRound[];

  publish_refs?: PublishRef[];        // 发布后填充（v2+）
}

interface RawMaterial {
  id: string;                         // 稳定 id，让下游 ref 可以指向它
  kind: "text" | "url" | "file" | "note";
  content: string;                    // 对 url/file：已解析的内容
  origin: string;                     // 路径或 url
}

interface PlatformVariant {
  platform: string;
  content: string;                    // 最终 text/markdown
  media?: MediaRef[];                 // 附件图片/视频（v2+）
  constraints_applied: string[];      // ["<= 280 chars", "hashtags <= 3"]
  inspired_by: AssetRef[];            // 本 variant 参考的 reference_posts / hot_topics（见 §4.7）
  style_patterns_applied: AssetRef[]; // refiner 应用的 style_patterns
  status: "drafting" | "pending_eval" | "accepted" | "rejected";
  eval_score?: number;                // 0..1，最后一次 eval 分
  revision_count: number;
}

interface EvalRound {
  round: number;
  target: StateRef;                   // 被评价的 variant/artifact（见 §4.7）
  audience_feedback: AudienceFeedback[];
  aggregated_score: number;
  actionable_feedback: ActionableFeedback[];
  verdict: "accept" | "revise" | "abort";
}

interface AudienceFeedback {
  from: AssetRef;                     // kind: "evaluator_persona"
  understood: boolean;
  engagement_likelihood: number;      // 0..1
  ai_smell_score: number;             // 0..1，越高越有 AI 味
  depth_score: number;                // 0..1
  comments: string;
}

interface ActionableFeedback {
  from: AssetRef;                     // 提出该反馈的 evaluator persona
  category: "tone" | "structure" | "clarity" | "depth" | "ai_smell" | "other";
  text: string;
  targets: StateRef[];                // 要改动的 artifact
  suggested_refs?: AssetRef[];        // 修订者应参考的 refs
}
```

存储：`content-harness/runs/<run_id>/piece.json`（活跃期），完成后归档。

### 4.4 AssetPool（每个 Persona 的累积学习）

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
  expires_at?: ISO8601;               // 用于基于 TTL 判断是否过时
  source_query: string;               // 发现它的 opencli 搜索
}

interface StylePattern {
  id: string;
  platform: string;
  pattern_type: "opening" | "transition" | "cta" | "tone" | "structure"
              | "vocab" | "emoji_use" | "hashtag_use";
  pattern_text: string;               // 自然语言描述
  example_ref_ids: string[];          // 体现该 pattern 的 reference_posts
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
  background: string;                 // 多句 persona 描述
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
  sentence_rhythms: string;           // 如 "short / short / long / question"
  typical_openings: string[];
  quirks: string[];
  extracted_from_piece_ids: string[];
  updated_at: ISO8601;
}
```

存储布局：

```
content-harness/data/asset-pools/<persona_id>/
  reference_posts.jsonl
  style_patterns.jsonl
  hot_topics.jsonl
  evaluator_personas.yaml
  own_history.jsonl
  voice_fingerprint.json
  blobs/                              # 大体积原始内容
    <sha256>.txt
```

**Scoping**：默认在 persona 级。Campaign 可以追加或 override（见 `Campaign.overrides`）；Piece 只读。

### 4.5 WorkPlan 和 Task（由 Planner 产出）

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
  params: Record<string, unknown>;    // task 专用 payload（非 ref 参数）
  deps: string[];                     // 必须先完成的 task id
  input_refs: AssetRef[];             // handler 应读取的 asset-pool refs（见 §4.7）
  result_ref?: StateRef;              // 成功后 handler 产物的位置
  acceptance_criteria: string;        // 自然语言描述，由 evaluator 检查
  gate_before: boolean;               // HITL：dispatch 前停
  gate_after: boolean;                // HITL：task 跑完后、verdict 路由前停
  status: "pending" | "running" | "completed" | "failed" | "skipped";
}
```

### 4.6 Verdict（由 Evaluator 产出）

```ts
type Verdict =
  | { kind: "continue" }
  | { kind: "revise"; task_id: string; feedback: string }
  | { kind: "redirect"; reason: string }
  | { kind: "done" }
  | { kind: "abort"; reason: string };
```

### 4.7 Reference discipline（AssetRef / StateRef）

Handlers 消费和产出的是**类型化的引用**，而不是数据的拷贝。这样 agent 可以追溯"一个 variant 为什么是现在这个样子"（哪些 ref 影响了它），task 可以被缓存和重放，evaluator 也能用精确的词汇给出反馈。数据模型里所有的指针都是以下两种之一：

```ts
// 指向 persona 的 AssetPool（跨 run 积累的知识）
type AssetRef =
  | { kind: "reference_post";    id: string }
  | { kind: "style_pattern";     id: string }
  | { kind: "hot_topic";         platform: string; topic: string }
  | { kind: "evaluator_persona"; id: string }
  | { kind: "own_post";          piece_id: string; platform: string }
  | { kind: "voice_fingerprint" };

// 指向当前 run 的 state/deliverables（仅限本 run）
type StateRef =
  | { kind: "raw_material";     piece_id: string; material_id: string }
  | { kind: "base_article";     piece_id: string }
  | { kind: "platform_variant"; piece_id: string; platform: string; variant_idx: number }
  | { kind: "eval_round";       piece_id: string; round: number }
  | { kind: "deliverable";      path: string };                     // runs/<run_id>/deliverables/ 下的文件
```

**Handler 合约**：

1. 从 `task.input_refs` 读 Planner 给你的 refs。通过 `infra.assets.resolve(pool, ref)` 解引用每个 ref，不要通过 `task.params` 直接传原始数据。
2. 成功时把产物的 StateRef 写入 `result_ref`，并把你实际用到的 AssetRef 塞进 artifact 本身（`PlatformVariant.inspired_by`、`PlatformVariant.style_patterns_applied`、`Piece.base_article.source_refs`…）。"你用了什么？"这个问题必须永远能通过读 artifact 回答。
3. Evaluator 的反馈两头都用 ref：`AudienceFeedback.from` 指向 evaluator persona，`ActionableFeedback.targets` 指向要改的 artifact，`ActionableFeedback.suggested_refs` 指向修订者该读的内容。

**为什么这很重要**：当 agent 被问到"这条 tweet 为什么听起来像 AI 写的？"，它可以顺着 `PlatformVariant.style_patterns_applied` → `StylePattern` 记录往下走，看到哪些 pattern 被触发了；当它跑 `revise` task 时，它确切知道该重新读哪些 AssetRef、该覆写哪个 StateRef。没有类型化的 ref，每个 handler 都会自己发明临时的指针字符串，agent 就没有一个稳定的方式去跟随它们。

## 5. `harness-core`（编排 package）

### 5.1 公开 API — `HarnessDomain` 接口

`harness-core` 以调用方传入的 domain 参数化：

```ts
interface HarnessDomain<TaskKind extends string, State> {
  // 计划
  planInitial(ctx: PlanContext<State>): Promise<WorkPlan<TaskKind>>;
  replan(ctx: PlanContext<State>, reason: string): Promise<WorkPlan<TaskKind>>;

  // Task 分发
  handlers: Record<TaskKind, TaskHandler<State>>;

  // 评价
  evaluate(state: State): Promise<Verdict>;
  isDone(state: State): boolean;

  // 状态管理
  initState(input: unknown): State;
  serializeState(state: State): object;
  deserializeState(obj: object): State;
}

interface TaskHandler<State> {
  (task: Task<string>, state: State, infra: InfraBundle): Promise<Delta<State>>;
}

interface Delta<State> {
  kind: "success" | "failure";
  patches: StatePatch[];              // JSON-patch 风格的部分更新
  cost: CostAccounting;
  logs?: LogEntry[];
  error?: { message: string; retryable: boolean };
}
```

`harness-core` 从 Infra 那里唯一拿到的是被注入的：

```ts
interface InfraBundle {
  llm: LLMClient;
  assets: AssetStore;
  logger: Logger;
  clock: Clock;
  // 注意：opencli 不在 InfraBundle 里——social-pipeline 直接 import 它，
  //       因为平台选择是 domain 专用的。
}
```

`RunConfig` 控制 loop 行为，由调用方提供：

```ts
interface RunConfig {
  run_id: string;                     // run 目录的稳定标识
  run_root: string;                   // runs/ 根路径
  budget: BudgetLimits;
  retry: { max_attempts: number; backoff_ms: number };
  gates: {
    post_plan: boolean;
    pre_publish: boolean;
  };
  gate_resolver: GateResolver;
  resume_from?: string;               // 要恢复的 run_id；可选
  thresholds: {
    eval_pass: number;                // 默认 0.7
    ai_smell_max: number;             // 默认 0.3
    depth_min: number;                // 默认 0.5
  };
  max_revisions: number;              // 默认 3
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

### 5.2 循环语义

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

### 5.3 状态、持久化、可恢复

每一次循环迭代往 run 目录写两个工件：

```
content-harness/runs/<run_id>/
  manifest.json              # run 元数据（started_at, config, domain_id）
  events.jsonl               # append-only 的 {task, delta} 日志
  state/
    state-0.json             # init 后快照
    state-1.json             # task 1 后快照
    ...
  plan/
    plan-0.json
    plan-1.json              # 只在 plan 变化时
    ...
  budget.json                # 滚动快照
  deliverables/              # handlers 写入的文件（比如 distilled patterns）
  logs/
    run.jsonl                # 结构化日志
```

**恢复**：`run` 可以接收 `resume_from: run_id` 选项，读取最新的 `state-N.json` 和 `plan-N.json`，继续循环。

### 5.4 Budget 模型

```ts
interface BudgetLimits {
  max_tokens?: number;
  max_usd?: number;
  max_iterations?: number;
  max_wall_seconds?: number;
}
```

任一上限触发 → `budget.exhausted()` 变 true；循环退出，返回 `ok: false` 和一个持久化的 state（用户可检查或恢复）。

V1 默认上限（可由 `RunConfig.budget` override）：

| 上限 | 默认值 | 理由 |
|-----|-------|------|
| `max_tokens` | 500_000 | 够跑约 15 轮 LLM 调用，含 eval 子 agent |
| `max_usd` | 5.00 | 开发期保守护栏 |
| `max_iterations` | 40 | 最多约 5 平台 variant × 3 修订 + 开销 |
| `max_wall_seconds` | 1800 | 30 分钟墙钟上限 |

### 5.5 Human-in-loop gate

两种 gate：

1. **结构性 gate**（run 级配置）：`post_plan`、`pre_publish`（未来）。循环在已知点检查 `config.gates.<name>`，开启则调用 `config.gate_resolver`。
2. **Task gate**（Planner 按 task 配置）：任何 task 可以设置 `gate_before: true`（dispatch 前停）或 `gate_after: true`（task 跑完后停，fresh `delta` 对 gate_resolver 可见）。

`gate_resolver` 是调用方提供的 async callback。调用类型：`post_plan`、`pre_publish`、`task_gate_before`、`task_gate_after`。在 CLI 模式下会弹 terminal 提示；在 headless 模式下可按规则自动批/拒。

MVP v1：
- `post_plan` gate 默认 **ON**
- Task gate：`refine_variant` task 带 `gate_after: true`（这就是"post-variant"的实现方式——variant 产出后、evaluator 跑之前循环停下来，让用户审核真正的输出）
- `pre_publish` gate 默认 ON 但是空操作（v1 无 publish 步骤）

### 5.6 Retry 与错误处理

`runWithRetry` 在可重试的错误（网络、瞬态 LLM 错误）上重试 `config.retry.max_attempts` 次。不可重试错误（handler 抛出 `Error` 且 `cause: "permanent"`）产生 kind 为 `failure` 的 `Delta`，evaluator 可以把它升级为 `revise`（带反馈重做）或 `redirect`（重新规划）。

### 5.7 `harness-core` 永不做的事

- 从不写 prompt
- 从不 import `@jackwener/opencli`
- 从不知道字符串 "twitter"
- 从不定义 `Persona`、`Campaign` 或任何业务 schema
- 从不直接调 `@anthropic-ai/sdk`；它调 `infra.llm`

## 6. `social-pipeline`（内容 package）

### 6.1 TaskKind 枚举

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

### 6.2 Handlers（每个 kind 一个文件）

```
src/handlers/
  research_refs.ts       # 0 LLM；调 opencli search
  research_trends.ts     # 0 LLM；调 opencli trending
  distill_style.ts       # LLM（cheap model）
  draft_base.ts          # LLM（main model）
  refine_variant.ts      # LLM（main model）
  eval_variant.ts        # LLM（cheap model，N 次调用 — 每个 evaluator persona 一次）
  revise.ts              # LLM（main model）
```

每个 handler 是一个纯 async 函数 `(task, state, infra) → Delta`。副作用限制为：

- 通过 `infra.assets` 读写 `AssetStore`
- 通过 `infra.llm` 调 LLM
- 直接 import `@jackwener/opencli` 调 opencli（允许：我们在内容层）

每个 handler 都有对应的 `handlers/<kind>.test.ts`，包含：

1. 使用录制的 opencli response fixture 的测试
2. Mock LLM 的测试，断言 prompt 结构
3. 失败模式测试，断言错误传播

### 6.3 Planner 逻辑（`domain.ts → planInitial`）

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
    # revise tasks 在 "revise" verdict 时动态插入

  return WorkPlan(tasks, budget_estimate)
```

**MVP v1 简化**：v1 planner 只发出 `research_refs`、`draft_base`、`refine_variant`、`eval_variant` 和（动态的）`revise` — 跳过 `research_trends` 和 `distill_style`。V1 里把风格指导内联到 `refine_variant` 的 prompt 里；v2 随着 asset pool 变大，会把它提升为独立的 `distill_style` task。

`replan` 在 `redirect` verdict 时被调用，可以收缩/扩展 DAG（例如，放弃一个表现不佳的平台，或增加 research）。

### 6.4 Evaluator：受众模拟

`domain.evaluate` 在每个 task 后被调用。对大多数 task kind，它只检查 `task.status === completed`，返回 `{kind: "continue"}`。对 `eval_variant` task，它参考 handler 写入的 fresh `EvalRound`：

```
aggregated = mean(audience_feedback.engagement_likelihood)  # 默认等权重
                                                            # Persona 可设每个 persona 的权重
ai_smell   = max(audience_feedback.ai_smell_score)   # 最坏情况
depth      = mean(audience_feedback.depth_score)
passed     = aggregated ≥ 0.7 AND ai_smell ≤ 0.3 AND depth ≥ 0.5

if passed:
  把 variant 标为 "accepted"；continue
else if revision_count < config.max_revisions:         # 默认 3
  带着去重、归属到各 persona 的 actionable feedback 做 revise
else:
  放弃本 variant（evaluator 返回 `redirect` 带 reason）
```

默认阈值（`0.7 / 0.3 / 0.5`）和 `max_revisions: 3` 存在 `RunConfig` 里，可按 run override。

`eval_variant.ts` 是真正跑子 agent 模拟的地方。对每个挂在 Persona 上的 `evaluator_persona`：

1. 构造 persona 专用 system prompt："You are {name}. Background: {background}. You are reading the following post and giving honest reactions. Answer the 5 questions below."
2. 用 variant 内容调 `infra.llm.complete(...)`
3. 把结构化响应解析为 `AudienceFeedback`

所有调用并行跑（`Promise.all`）。

### 6.5 LLM 模型分层

通过 `infra.llm` 配置两层：

- **main**：`claude-opus-4-6` — 用于 `draft_base`、`refine_variant`、`revise`
- **cheap**：`claude-haiku-4-5-20251001` — 用于 `distill_style`、`eval_variant`

Prompt cache（`cache_control: ephemeral`）用于同一 run 中多次调用里出现的静态 persona context。

### 6.6 HITL gate 默认值（MVP v1）

| Gate | 默认 | 机制 |
|------|-----|------|
| pre-plan (A) | OFF | n/a |
| post-plan (B) | **ON** | `run` 中的结构性 gate |
| post-base (C) | OFF | n/a |
| post-variant (D) | **ON** | `refine_variant` task 带 `gate_after: true` — 循环停下来，刚写入的 variant 在 `delta` 中 |
| pre-publish (E) | **ON** 但空操作（v1 无 publish） | 结构性 gate |

## 7. Infra 层

### 7.1 `@jackwener/opencli`（已存在）

由需要平台访问的 handlers 直接 import。不做 wrapper — harness 不需要在 opencli 上抽象一层，因为 social-pipeline 的 handlers 本来就知道自己要打哪个平台。V1 用到的示例：

- `opencli twitter search --query "..."` → reference_posts
- `opencli twitter trending` → hot_topics

### 7.2 LLM 客户端

`@anthropic-ai/sdk` 的薄 wrapper，暴露 `complete({ model, system, messages, cache_control, max_tokens })`。职责：

- 路由 `main` vs `cheap` 层
- 对静态 system block 应用 prompt cache
- 发出 cost 事件（输入+输出 token，$ 估计）
- 在 `429` / `529` 上指数退避重试

放在 `harness-core/src/infra/llm.ts`，各 domain 共享。

### 7.3 Asset store

`content-harness/data/asset-pools/` 下的文件系统 JSONL + blob 实现。API：

```ts
interface AssetStore {
  append<T>(pool: string, bucket: string, records: T[]): Promise<void>;
  query<T>(pool: string, bucket: string, filter: AssetFilter): Promise<T[]>;
  resolve<T>(pool: string, ref: AssetRef): Promise<T | null>;     // 解引用任意 AssetRef — handler 的主入口
  putBlob(pool: string, key: string, bytes: Uint8Array): Promise<string>;
  getBlob(pool: string, key: string): Promise<Uint8Array | null>;
  ttlCheck(pool: string, bucket: string, now: Date): Promise<StalenessReport>;
}
```

**TTL**：每个 bucket 可配置（例如 `hot_topics: 24h`、`reference_posts: 30d`、`style_patterns: 7d`）。

### 7.4 Cost tracker

从每个 handler 收集 `CostAccounting` delta，暴露给 `Budget`。发出结构化 cost 事件到日志。

### 7.5 结构化日志

JSON 写到 stdout 和文件，每事件一行，打 `run_id`、`task_id`、`kind` 标签。被 persistence 层消费为 `events.jsonl`，也供人工 debug。

## 8. MVP v1 范围

### 8.1 范围内

- `harness-core` 最小可用：
  - `planInitial` / `replan` / 循环驱动
  - `Budget`，带 token 和迭代上限
  - 带恢复能力的文件系统持久化
  - 结构性 post-plan gate；task 级 gate
  - Retry（最多 2 次，固定退避）
- `social-pipeline` 最小可用：
  - 只做 Twitter（opencli twitter 适配器最丰富）
  - TaskKinds：`research_refs`、`draft_base`、`refine_variant`、`eval_variant`、`revise`
  - V1 省略：`research_trends`、`distill_style`（把最小的 Twitter 风格提示硬写进 prompt）
  - 为一个测试 Persona 硬编码 2–3 个 `evaluator_personas`（§1 的 AI infra 工程师 persona）
  - 不发布 — handler 把最终 variant 写到 stdout 和 `runs/<run_id>/deliverables/twitter_variant.md`
- 一个完整走通的例子：AI infra 工程师 Persona，一个 Campaign（"Q2 infra insights"），一条 Piece（"what I learned debugging the harness loop"），端到端跑通，产出一条通过 eval 阈值的 Twitter thread。

### 8.2 V1 范围外（延后到 v2+）

- LinkedIn / Medium / 小红书 handlers
- `research_trends` 和 `distill_style` 作为独立 task（v1 内联到 prompt）
- 通过 opencli 发布
- Voice fingerprint 抽取
- `own_history` 反馈回路
- 排期 run、cron、webhook
- 跨 piece 的 asset pool 共享（v1 每次 run 用新 pool，简化）
- 媒体附件处理（图片、视频）

### 8.3 V1 完成定义

```
前提：  一份 Persona yaml、一份 Campaign yaml、一份 Piece yaml
       （raw text + intent）
当：    我运行 `pnpm --filter social-pipeline run dev -- \
             --persona ./data/personas/ai-infra.yaml \
             --campaign ./data/campaigns/q2-infra.yaml \
             --piece ./data/pieces/harness-debug.yaml`
则：    在 post-plan gate 批准 plan，
       在 post-variant gate 批准 variant 后，
       我得到一条 Twitter-ready variant 写到
       runs/<run_id>/deliverables/twitter_variant.md，
       其 `aggregated_score ≥ 0.7`、`ai_smell_score ≤ 0.3`，
       `events.jsonl` 完全可重放。
```

## 9. 测试策略（TDD，vitest）

### 9.1 原则

- 每个 package 使用 vitest。
- 每个 handler 有自己的测试文件（`<handler>.test.ts`），测试先于实现写。
- Opencli 和 LLM 调用在 handler 单测里用提交在 `tests/fixtures/` 的 fixture 文件 stub 掉。
- Golden tests 对比 prompt 输出和已提交的期望值，捕获 prompt drift。

### 9.2 `harness-core` 测试

- **Planner**：给定一个 fake domain，`planInitial` 被调用并返回 plan。Loop 按依赖顺序分发 task。
- **Loop dispatch**：尊重 DAG；检测到环；卡死检测会报错。
- **Budget**：任一上限到达时 loop 停；持久化的 state 可恢复。
- **Verdict 路由**：每种 verdict 驱动预期的状态转换。
- **Persistence**：snapshot + resume round-trip 无损。
- **HITL gate**：`gate_resolver` 在正确时机被调用；拒绝会把 task 标为 rejected。
- **Retry**：瞬态错误重试 `max_attempts` 次；永久错误不重试。

### 9.3 `social-pipeline` 测试

- **每个 handler 的单测 + fixture**：
  - `research_refs.test.ts`：喂 fake opencli 客户端，断言搜索参数正确、写入 asset pool 正确。
  - `draft_base.test.ts`：喂 mock LLM，断言 prompt 结构包含 persona voice 和 raw materials，输出写到 `state.piece.base_article`。
  - `refine_variant.test.ts`：断言约束字符串被应用，输出长度尊重平台限制。
  - `eval_variant.test.ts`：喂 mock LLM 返回预设的 `AudienceFeedback`，断言聚合数学正确、`EvalRound` 结构正确。
  - `revise.test.ts`：断言反馈被带入下一稿 draft。
- **集成测试**：MVP v1 端到端 run，用一个小 Persona、fake opencli、fake LLM。断言 `deliverables/twitter_variant.md` 存在且匹配一个 golden 文件。

### 9.4 Fixture 模式

沿用 opencli 的惯例：用 helper 脚本（`pnpm record-fixtures`）录制一次真实响应，把脱敏后的 JSON 提交到 `tests/fixtures/`，测试时回放。平台 API 破坏时再轮换 fixture。

## 10. Repo 布局

```
AI项目/
  opencli/                                  ← 保持不动
  content-harness/                          ← 新 monorepo
    pnpm-workspace.yaml
    package.json                            # 根 scripts（dev/test/lint）
    tsconfig.base.json
    .gitignore                              # runs/, data/（除 fixtures）
    README.md
    docs/
      superpowers/
        specs/
          2026-04-11-content-harness-social-pipeline-design.md  ← 本文件
    packages/
      harness-core/
        package.json                        # @content-harness/core
        tsconfig.json
        src/
          index.ts                          # barrel
          types.ts                          # HarnessDomain, Task, Verdict, Delta, ...
          planner.ts
          generator.ts                      # task 分发 wrapper
          evaluator.ts                      # verdict 路由 helper
          loop.ts
          budget.ts
          persistence.ts
          retry.ts
          gates.ts
          infra/
            llm.ts                          # LLM 客户端接口 + 实现
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
          domain.ts                         # 实现 HarnessDomain
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
            personas.ts                     # v1 默认 evaluator personas
            simulator.ts                    # 子 agent 分发
            aggregator.ts                   # 分数计算
          asset-store.ts                    # 文件系统实现
        tests/
          handlers/
            research_refs.test.ts
            draft_base.test.ts
            refine_variant.test.ts
            eval_variant.test.ts
            revise.test.ts
          integration/
            e2e.test.ts                     # MVP v1 端到端
          fixtures/
        bin/
          run.ts                            # CLI 入口
    data/                                   # 运行时；gitignore 除 fixtures 外
      personas/
        ai-infra-engineer-liu.yaml          # 示例 persona（v1 测试目标）
        real-estate-agent-sarah.yaml        # 示例 persona（证明通用性）
      campaigns/
      pieces/
      asset-pools/
    runs/                                   # gitignore
```

## 11. 开放问题 / 未来工作

1. **子 agent 隔离**：v1 的 evaluator 子 agent 是进程内 LLM 调用。如果某个 persona 需要真正隔离的 context 或自己的 tool 访问，可能需要进程级或 Claude Agent SDK 级的隔离。
2. **跨 piece 的 research 复用**：v1 把 asset pool scoped 到 persona 级，但不会把一条 piece 的 research 成果共享给后续 piece。v2 应该加 asset-pool 级 TTL + query 复用。
3. **Voice fingerprint**：schema 定义了但 v1 不填充。当用户积累了足够多过去的帖子，应该加一个 task 重新抽取 fingerprint 并用它来 bias `draft_base`。
4. **Metrics 反馈回路**：`own_history` metrics 定义了但 v1 没有 ingestion 路径。v2 需要一个 `sync_metrics` task 轮询 opencli 拿用户最近的帖子、更新 `own_history`。
5. **多语言 evaluator personas**：v1 只跑英文 Twitter。加小红书时 evaluator persona 必须支持中文 prompt。
6. **并行 task 执行**：v1 串行跑 task。跨平台的 `research_refs` 可以并行；v1 之后再回头看。
7. **Cost 透明度 surface**：v1 记录 cost；v2 可在 run 结束时展示 per-run cost 报告。
8. **回滚**：如果后续接入发布，我们需要一个"撤回/编辑"路径，使用 opencli 的 post 修改适配器。

---

## 12. 示例 personas

两个有代表性的 Persona，展示框架的 persona 无关性。两个都存在 `content-harness/data/personas/*.yaml`，运行时加载，不需要任何代码改动。AI infra 工程师是 v1 的测试目标；房产经纪人的作用是证明框架能弯折到完全不同的 domain、audience、平台组合。

### 12.1 `ai-infra-engineer-liu.yaml` — v1 测试目标

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

### 12.2 `real-estate-agent-sarah.yaml` — 通用性演示

一个完全不同的 Persona：中文为主、小红书优先、面向 C 端、domain 里是专家但对 practitioner 说话。证明这个框架没有硬编码英文、技术 tone 或 Twitter 形状的输出。

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

**两个 Persona 在框架里各自拉扯什么维度**：

| 维度 | AI infra 工程师 | 房产经纪人 |
|-----|----------------|-----------|
| 主语言 | 英文 | 中文（中英混合） |
| 主平台 | Twitter | 小红书 |
| 受众 | B2B 同行 | B2C 家庭 |
| 成功指标 | engagement | clicks |
| Evaluator personas | 技术怀疑派 | 买家原型 |
| Voice | 分析式 | 温暖咨询式 |
| `style_references.emulate` 目标 | 英文技术 Twitter | 中文小红书房产号 |

如果同一个 `harness-core` 可以零代码改动驱动这两者都通过 eval 阈值，那么 §3 的层分离就做到了它该做的事。

---
