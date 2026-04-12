import type { Delta, InfraBundle, Task, TaskHandler } from "@content-harness/core";
import type { SocialState } from "../state.js";

export const draftBaseHandler: TaskHandler<SocialState> = async (
  task: Task<string>,
  state: SocialState,
  infra: InfraBundle,
): Promise<Delta<SocialState>> => {
  const persona = state.persona;
  const piece = state.piece;

  const staticSystem = [
    `You are ghostwriting for ${persona.identity.name}.`,
    `Bio: ${persona.identity.long_bio}`,
    `Voice: tone=${persona.voice.tone}. POV=${persona.voice.point_of_view}.`,
    `prefer words: ${persona.voice.vocabulary.prefer.join(", ") || "(none)"}`,
    `avoid words: ${persona.voice.vocabulary.avoid.join(", ") || "(none)"}`,
    `Example phrases: ${persona.voice.example_phrases.join(" / ")}`,
    `Primary topics: ${persona.domain.primary_topics.join(", ")}`,
    `Audience: ${persona.audience.description}`,
    `Audience pain points: ${persona.audience.pain_points.join("; ") || "(none)"}`,
    `Red lines: ${persona.success_metrics.red_lines.join("; ") || "(none)"}`,
  ].join("\n");

  const turnSystem = [
    `Write the BASE ARTICLE — a platform-agnostic longform markdown draft that captures the full thinking.`,
    `This draft will later be refined into platform-specific variants (e.g., a Twitter thread).`,
    `Do NOT write for any one platform. Write the full idea once, well.`,
    `The voice rules above are absolute.`,
  ].join("\n");

  const materialsText = piece.input.raw_materials
    .map((m) => `- (${m.kind}, id=${m.id}) ${m.content}`)
    .join("\n");

  const userContent = `Intent: ${piece.input.intent}

Raw materials:
${materialsText || "(none)"}

Please produce a markdown base article.`;

  const reviseFeedback = typeof task.params.revise_feedback === "string" ? task.params.revise_feedback : null;
  const messages = reviseFeedback
    ? [
        { role: "user" as const, content: userContent },
        { role: "assistant" as const, content: state.piece.base_article?.markdown ?? "" },
        { role: "user" as const, content: `Revise the base article based on this feedback:\n${reviseFeedback}` },
      ]
    : [{ role: "user" as const, content: userContent }];

  const result = await infra.llm.complete({
    tier: "main",
    system: [
      { text: staticSystem, cache: true },
      { text: turnSystem, cache: false },
    ],
    messages,
    max_tokens: 1500,
    temperature: 0.6,
  });

  const now = infra.clock.now().toISOString();

  return {
    kind: "success",
    patches: [
      {
        op: "set",
        path: ["piece", "base_article"],
        value: {
          markdown: result.text,
          produced_at: now,
          source_refs: [],
        },
      },
      { op: "set", path: ["piece", "state"], value: "refining" },
    ],
    cost: result.cost,
    result_ref: { kind: "base_article", piece_id: piece.id },
  };
};
