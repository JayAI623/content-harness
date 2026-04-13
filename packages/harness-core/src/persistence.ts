import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { appendLineSynced, writeAtomic } from "./persistence-atomic.js";
import type { BudgetSnapshot, Delta, Task, Verdict, WorkPlan } from "./types.js";

export interface CreateRunOptions {
  run_root: string;
  run_id: string;
  domain_id: string;
  started_at: Date;
}

export async function createRun(opts: CreateRunOptions): Promise<string> {
  const dir = join(opts.run_root, opts.run_id);
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, "state"), { recursive: true });
  await mkdir(join(dir, "plan"), { recursive: true });
  await mkdir(join(dir, "deliverables"), { recursive: true });
  await mkdir(join(dir, "logs"), { recursive: true });

  const manifest = {
    run_id: opts.run_id,
    domain_id: opts.domain_id,
    started_at: opts.started_at.toISOString(),
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  // Touch events log so downstream tooling sees it exists.
  await writeFile(join(dir, "events.jsonl"), "", { flag: "wx" }).catch(() => {});
  return dir;
}

interface SnapshotPayload {
  state: unknown;
  plan: WorkPlan<string>;
  budget: BudgetSnapshot;
}

export async function snapshot(
  runDir: string,
  step: number,
  payload: SnapshotPayload,
): Promise<void> {
  await writeAtomic(
    join(runDir, "state", `state-${step}.json`),
    JSON.stringify(payload.state, null, 2) + "\n",
  );
  await writeAtomic(
    join(runDir, "plan", `plan-${step}.json`),
    JSON.stringify(payload.plan, null, 2) + "\n",
  );
  await writeAtomic(
    join(runDir, "budget.json"),
    JSON.stringify(payload.budget, null, 2) + "\n",
  );
}

export interface EventEntry {
  task: Task<string>;
  delta: Delta<unknown>;
  verdict?: Verdict;
}

export async function appendEvent(runDir: string, entry: EventEntry): Promise<void> {
  await appendLineSynced(join(runDir, "events.jsonl"), JSON.stringify(entry) + "\n");
}

export async function loadLatestState<S>(runDir: string): Promise<S | null> {
  const stateDir = join(runDir, "state");
  const entries = await readdir(stateDir).catch(() => [] as string[]);
  if (entries.length === 0) return null;
  const latestIdx = Math.max(
    ...entries
      .filter((e) => e.startsWith("state-") && e.endsWith(".json"))
      .map((e) => Number(e.slice(6, -5))),
  );
  const raw = await readFile(join(stateDir, `state-${latestIdx}.json`), "utf8");
  return JSON.parse(raw) as S;
}

export async function loadLatestPlan<TK extends string>(runDir: string): Promise<WorkPlan<TK> | null> {
  const planDir = join(runDir, "plan");
  const entries = await readdir(planDir).catch(() => [] as string[]);
  if (entries.length === 0) return null;
  const latestIdx = Math.max(
    ...entries
      .filter((e) => e.startsWith("plan-") && e.endsWith(".json"))
      .map((e) => Number(e.slice(5, -5))),
  );
  const raw = await readFile(join(planDir, `plan-${latestIdx}.json`), "utf8");
  return JSON.parse(raw) as WorkPlan<TK>;
}

export interface ResumedRun<S, TK extends string> {
  state: S;
  plan: WorkPlan<TK>;
  budget: BudgetSnapshot;
  step: number;
}

function indicesIn(dir: string, prefix: string): Promise<number[]> {
  return readdir(dir)
    .catch(() => [] as string[])
    .then((entries) =>
      entries
        .filter((e) => e.startsWith(`${prefix}-`) && e.endsWith(".json"))
        .map((e) => Number(e.slice(prefix.length + 1, -5)))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b),
    );
}

export async function resumeRun<S, TK extends string>(
  runDir: string,
): Promise<ResumedRun<S, TK> | null> {
  const stateIdxs = new Set(await indicesIn(join(runDir, "state"), "state"));
  const planIdxs = new Set(await indicesIn(join(runDir, "plan"), "plan"));
  let highest = -1;
  for (const n of stateIdxs) {
    if (planIdxs.has(n) && n > highest) highest = n;
  }
  if (highest < 0) return null;
  const [stateRaw, planRaw, budgetRaw] = await Promise.all([
    readFile(join(runDir, "state", `state-${highest}.json`), "utf8"),
    readFile(join(runDir, "plan", `plan-${highest}.json`), "utf8"),
    readFile(join(runDir, "budget.json"), "utf8").catch(() => "null"),
  ]);
  return {
    state: JSON.parse(stateRaw) as S,
    plan: JSON.parse(planRaw) as WorkPlan<TK>,
    budget: (JSON.parse(budgetRaw) as BudgetSnapshot | null) ?? {
      used_tokens: 0,
      used_usd: 0,
      iterations: 0,
      wall_seconds: 0,
      exhausted: false,
    },
    step: highest,
  };
}
