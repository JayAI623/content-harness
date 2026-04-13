// ─── Reference base shapes ───────────────────────────────────────
// AssetRef: a pointer to an artifact stored in an AssetStore. Core only knows
// it has a kind discriminator; domains extend with their own typed unions
// (see SocialAssetRef in packages/social-pipeline/src/schemas/piece.ts for the
// social domain's version, which is a discriminated zod union).
export interface AssetRef {
  kind: string;
  [key: string]: unknown;
}

// StateRef: a pointer into a domain's state tree. Same pattern as AssetRef;
// see SocialStateRef in packages/social-pipeline/src/schemas/piece.ts for the
// social domain's discriminated zod union.
export interface StateRef {
  kind: string;
  [key: string]: unknown;
}

// ─── Tasks & plans ───────────────────────────────────────────────
export interface Task<TaskKind extends string = string> {
  id: string;
  kind: TaskKind;
  params: Record<string, unknown>;
  deps: string[];
  input_refs: AssetRef[];
  acceptance_criteria: string;
  gate_before: boolean;
  gate_after: boolean;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
}

export interface WorkPlan<TaskKind extends string = string> {
  plan_id: string;
  piece_id: string;
  tasks: Task<TaskKind>[];
  budget_estimate: { tokens: number; usd: number; iterations: number };
}

// ─── Verdicts & deltas ───────────────────────────────────────────
export type Verdict =
  | { kind: "continue" }
  | { kind: "revise"; task_id: string; feedback: string }
  | { kind: "redirect"; reason: string }
  | { kind: "done" }
  | { kind: "abort"; reason: string };

export interface CostAccounting {
  input_tokens: number;
  output_tokens: number;
  usd: number;
}

export const zeroCost: CostAccounting = { input_tokens: 0, output_tokens: 0, usd: 0 };

export interface StatePatch {
  op: "set" | "append" | "merge";
  path: string[];
  value: unknown;
}

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
  ts: string;
}

export interface Delta<State> {
  kind: "success" | "failure";
  patches: StatePatch[];
  cost: CostAccounting;
  logs?: LogEntry[];
  error?: { message: string; retryable: boolean };
  // Handlers may attach a reference to the artifact they produced; it's written
  // to events.jsonl alongside the delta so run consumers can locate results.
  result_ref?: StateRef;
}

// ─── Domain interface ────────────────────────────────────────────
export interface PlanContext<State> {
  state: State;
  config: RunConfig;
}

export interface TaskHandler<State> {
  (task: Task<string>, state: State, infra: InfraBundle): Promise<Delta<State>>;
}

export interface HarnessDomain<TaskKind extends string, State> {
  planInitial(ctx: PlanContext<State>): Promise<WorkPlan<TaskKind>>;
  replan(ctx: PlanContext<State>, reason: string): Promise<WorkPlan<TaskKind>>;
  handlers: Record<TaskKind, TaskHandler<State>>;
  evaluate(ctx: PlanContext<State>): Promise<Verdict>;
  isDone(state: State): boolean;
  initState(input: unknown): State;
  serializeState(state: State): object;
  deserializeState(obj: object): State;
}

// ─── Infra ──────────────────────────────────────────────────────
export interface LLMCompleteOptions {
  tier: "main" | "cheap";
  system: string | Array<{ text: string; cache?: boolean }>;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  max_tokens: number;
  temperature?: number;
}

export interface LLMCompleteResult {
  text: string;
  cost: CostAccounting;
  stop_reason: string;
}

export interface LLMClient {
  complete(opts: LLMCompleteOptions): Promise<LLMCompleteResult>;
}

export interface AssetStore {
  append<T>(pool: string, bucket: string, records: T[]): Promise<void>;
  query<T>(pool: string, bucket: string, filter?: Record<string, unknown>): Promise<T[]>;
  resolve<T>(pool: string, ref: AssetRef): Promise<T | null>;
  putBlob(pool: string, key: string, bytes: Uint8Array): Promise<string>;
  getBlob(pool: string, key: string): Promise<Uint8Array | null>;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface Clock {
  now(): Date;
}

export interface InfraBundle {
  llm: LLMClient;
  assets: AssetStore;
  logger: Logger;
  clock: Clock;
}

// ─── Run config ──────────────────────────────────────────────────
export interface BudgetLimits {
  max_tokens?: number;
  max_usd?: number;
  max_iterations?: number;
  max_wall_seconds?: number;
}

export interface BudgetSnapshot {
  used_tokens: number;
  used_usd: number;
  iterations: number;
  wall_seconds: number;
  exhausted: boolean;
  limit_hit?: "tokens" | "usd" | "iterations" | "time";
}

export type GateDecision = "approve" | "reject";

export type GateEvent<TK extends string, S> =
  | { kind: "post_plan"; plan: WorkPlan<TK> }
  | { kind: "pre_publish"; state: S }
  | { kind: "task_gate_before"; task: Task<TK> }
  | { kind: "task_gate_after"; task: Task<TK>; delta: Delta<S> };

export interface GateResolver {
  <TK extends string, S>(event: GateEvent<TK, S>): Promise<GateDecision>;
}

export interface RunConfig {
  run_id: string;
  run_root: string;
  budget: BudgetLimits;
  retry: { max_attempts: number; backoff_ms: number };
  gates: {
    post_plan: boolean;
    pre_publish: boolean;
  };
  gate_resolver: GateResolver;
  thresholds: {
    eval_pass: number;
    ai_smell_max: number;
    depth_min: number;
  };
  max_revisions: number;
}

export interface RunResult<State> {
  ok: boolean;
  state: State;
  budget: BudgetSnapshot;
  reason?: string;
  run_dir: string;
}
