import { createInterface } from "node:readline/promises";
import type { GateDecision, GateEvent, GateResolver } from "./types.js";

export const autoApproveGateResolver: GateResolver = async () => "approve";
export const autoRejectGateResolver: GateResolver = async () => "reject";

export function scriptedGateResolver(script: GateDecision[]): GateResolver {
  const queue = [...script];
  return async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("scripted gate resolver exhausted");
    return next;
  };
}

function summarize<TK extends string, S>(event: GateEvent<TK, S>): string {
  switch (event.kind) {
    case "post_plan":
      return `[post_plan] plan=${event.plan.plan_id} piece=${event.plan.piece_id} tasks=${event.plan.tasks.length}`;
    case "pre_publish":
      return `[pre_publish] about to publish (state attached)`;
    case "task_gate_before":
      return `[task_gate_before] task=${event.task.id} kind=${event.task.kind}`;
    case "task_gate_after":
      return `[task_gate_after] task=${event.task.id} kind=${event.task.kind} result=${event.delta.kind}`;
  }
}

export function cliGateResolver(): GateResolver {
  return async (event) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write(`\n--- GATE ---\n${summarize(event)}\n`);
      if (event.kind === "post_plan") {
        for (const t of event.plan.tasks) {
          process.stdout.write(`  • ${t.id} (${t.kind}) deps=[${t.deps.join(",")}]\n`);
        }
      }
      if (event.kind === "task_gate_after" && event.delta.kind === "success") {
        const firstText = event.delta.patches.find((p) => typeof p.value === "string");
        if (firstText) process.stdout.write(`  result preview: ${String(firstText.value).slice(0, 200)}\n`);
      }
      const answer = (await rl.question("Approve? [y/N] ")).trim().toLowerCase();
      return answer === "y" || answer === "yes" ? "approve" : "reject";
    } finally {
      rl.close();
    }
  };
}
