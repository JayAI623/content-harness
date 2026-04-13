// Social-domain typed refs. These satisfy core's `AssetRef`/`StateRef`
// structural interface because every variant has a string `kind`.
// The zod schemas in ./schemas/piece.ts remain the runtime validators;
// these types are just for compile-time narrowing in handlers.

export type SocialAssetRef =
  | { kind: "reference_post";    id: string }
  | { kind: "style_pattern";     id: string }
  | { kind: "hot_topic";         platform: string; topic: string }
  | { kind: "evaluator_persona"; id: string }
  | { kind: "own_post";          piece_id: string; platform: string }
  | { kind: "voice_fingerprint" };

export type SocialStateRef =
  | { kind: "raw_material";     piece_id: string; material_id: string }
  | { kind: "base_article";     piece_id: string }
  | { kind: "platform_variant"; piece_id: string; platform: string; variant_idx: number }
  | { kind: "eval_round";       piece_id: string; round: number }
  | { kind: "deliverable";      path: string };
