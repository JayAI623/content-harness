import type { Delta, InfraBundle, Task, TaskHandler } from "@content-harness/core";
import type { OpencliClient } from "../opencli-client.js";
import type { ReferencePost } from "../schemas/index.js";
import type { SocialState } from "../state.js";

export interface ResearchRefsDeps {
  opencli: OpencliClient;
}

export function makeResearchRefsHandler(deps: ResearchRefsDeps): TaskHandler<SocialState> {
  return async (task: Task<string>, state: SocialState, infra: InfraBundle): Promise<Delta<SocialState>> => {
    const platform = String(task.params.platform ?? "twitter");
    const query = String(task.params.query ?? state.piece.input.intent);
    const limit = Number(task.params.limit ?? 20);

    infra.logger.info("research_refs.start", { platform, query });

    if (platform !== "twitter") {
      return {
        kind: "failure",
        patches: [],
        cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
        error: { message: `research_refs only supports twitter in v1, got ${platform}`, retryable: false },
      };
    }

    try {
      const results = await deps.opencli.twitterSearch(query, limit);
      if (results.length === 0) {
        return {
          kind: "failure",
          patches: [],
          cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
          error: { message: `opencli returned no reference_posts for query '${query}'`, retryable: true },
        };
      }

      const now = infra.clock.now().toISOString();
      const records: ReferencePost[] = results.map((r) => ({
        id: `rp-${platform}-${r.id}`,
        platform,
        author: r.author,
        url: r.url,
        content: r.content,
        engagement: {
          ...(r.engagement?.likes !== undefined && { likes: r.engagement.likes }),
          ...(r.engagement?.retweets !== undefined && { shares: r.engagement.retweets }),
          ...(r.engagement?.replies !== undefined && { comments: r.engagement.replies }),
          ...(r.engagement?.views !== undefined && { views: r.engagement.views }),
        },
        topic_tags: [],
        collected_at: now,
        source_query: query,
      }));

      await infra.assets.append(state.persona.asset_pool_id, "reference_posts", records);
      infra.logger.info("research_refs.done", { count: records.length });

      return {
        kind: "success",
        patches: [
          {
            op: "merge",
            path: ["asset_pool_summary"],
            value: {
              refs_last_refreshed: now,
              reference_post_count: state.asset_pool_summary.reference_post_count + records.length,
            },
          },
        ],
        cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      };
    } catch (err) {
      return {
        kind: "failure",
        patches: [],
        cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
        error: { message: err instanceof Error ? err.message : String(err), retryable: true },
      };
    }
  };
}
