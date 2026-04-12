import type { EvaluatorPersona } from "../schemas/index.js";

export const DEFAULT_EVALUATOR_PERSONAS: EvaluatorPersona[] = [
  {
    id: "senior-ai-eng-skeptical",
    name: "Marta — Senior AI Engineer",
    background:
      "10 years infra; currently leads LLM platform at a fintech. Skeptical of hype, pattern-matches on implementation details, wants numbers.",
    interests: ["agent loops", "eval infra", "cost engineering"],
    pain_points: ["vague claims", "missing numbers", "no failure modes discussed"],
    reading_goals: ["take away one concrete lesson I can apply on Monday"],
    critic_style: "strict",
    language: "en",
  },
  {
    id: "startup-cto-buying-time",
    name: "Akira — Startup CTO",
    background:
      "CTO of a 10-person B2B SaaS. Ships products under time pressure. Reads Twitter at 11pm to decide what tools are worth a spike tomorrow.",
    interests: ["what to build vs buy", "time-to-ship", "team force multipliers"],
    pain_points: ["long threads with no TLDR", "theory without real usage", "obvious advice"],
    reading_goals: ["decide in 30 seconds whether this is worth reading fully"],
    critic_style: "balanced",
    language: "en",
  },
  {
    id: "agent-framework-maintainer",
    name: "Priya — OSS Maintainer",
    background:
      "Maintains a popular agent framework. Knows the tradeoffs intimately. Will immediately spot hand-wavy claims and pattern conflicts.",
    interests: ["architectural tradeoffs", "edge cases", "prior art"],
    pain_points: ["reinvention without attribution", "ignoring known tradeoffs"],
    reading_goals: ["is this person's thinking rigorous enough to take seriously"],
    critic_style: "strict",
    language: "en",
  },
];
