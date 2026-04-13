import { appendFile, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AssetRef, AssetStore } from "@content-harness/core";
import type { SocialAssetRef } from "./schemas/index.js";

const BUCKETS_JSONL = new Set([
  "reference_posts",
  "style_patterns",
  "hot_topics",
  "own_history",
  "evaluator_personas",
]);

function bucketFile(root: string, pool: string, bucket: string): string {
  return join(root, pool, `${bucket}.jsonl`);
}

async function ensurePoolDir(root: string, pool: string): Promise<void> {
  await mkdir(join(root, pool), { recursive: true });
  await mkdir(join(root, pool, "blobs"), { recursive: true });
}

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export function makeFilesystemAssetStore(root: string): AssetStore {
  return {
    async append<T>(pool: string, bucket: string, records: T[]): Promise<void> {
      if (!BUCKETS_JSONL.has(bucket)) {
        throw new Error(`unknown bucket: ${bucket}`);
      }
      await ensurePoolDir(root, pool);
      const path = bucketFile(root, pool, bucket);
      const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
      await appendFile(path, lines, "utf8");
    },

    async query<T>(pool: string, bucket: string, _filter?: Record<string, unknown>): Promise<T[]> {
      if (!BUCKETS_JSONL.has(bucket)) return [];
      return readJsonl<T>(bucketFile(root, pool, bucket));
    },

    async resolve<T>(pool: string, ref: AssetRef): Promise<T | null> {
      // Core's AssetRef is structural; this filesystem store is specifically
      // for the social domain, so narrow to SocialAssetRef for typed dispatch.
      const sref = ref as SocialAssetRef;
      switch (sref.kind) {
        case "reference_post": {
          const all = await readJsonl<{ id: string }>(bucketFile(root, pool, "reference_posts"));
          return (all.find((r) => r.id === sref.id) as T | undefined) ?? null;
        }
        case "style_pattern": {
          const all = await readJsonl<{ id: string }>(bucketFile(root, pool, "style_patterns"));
          return (all.find((r) => r.id === sref.id) as T | undefined) ?? null;
        }
        case "hot_topic": {
          const all = await readJsonl<{ platform: string; topic: string }>(bucketFile(root, pool, "hot_topics"));
          return (all.find((r) => r.platform === sref.platform && r.topic === sref.topic) as T | undefined) ?? null;
        }
        case "evaluator_persona": {
          const all = await readJsonl<{ id: string }>(bucketFile(root, pool, "evaluator_personas"));
          return (all.find((r) => r.id === sref.id) as T | undefined) ?? null;
        }
        case "own_post": {
          const all = await readJsonl<{ piece_id: string; platform: string }>(bucketFile(root, pool, "own_history"));
          return (all.find((r) => r.piece_id === sref.piece_id && r.platform === sref.platform) as T | undefined) ?? null;
        }
        case "voice_fingerprint": {
          const path = join(root, pool, "voice_fingerprint.json");
          try {
            const raw = await readFile(path, "utf8");
            return JSON.parse(raw) as T;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw err;
          }
        }
        default: {
          // Exhaustiveness check against SocialAssetRef: if a new variant is
          // added without a case above, this assignment fails to compile.
          const _exhaustive: never = sref;
          throw new Error(
            `asset-store: unsupported ref kind '${(sref as { kind: string }).kind}' for pool '${pool}'`,
          );
        }
      }
    },

    async putBlob(pool: string, key: string, bytes: Uint8Array): Promise<string> {
      await ensurePoolDir(root, pool);
      const path = join(root, pool, "blobs", key);
      await writeFile(path, bytes);
      return key;
    },

    async getBlob(pool: string, key: string): Promise<Uint8Array | null> {
      try {
        const buf = await readFile(join(root, pool, "blobs", key));
        return new Uint8Array(buf);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
  };
}

export async function poolExists(root: string, pool: string): Promise<boolean> {
  try {
    const s = await stat(join(root, pool));
    return s.isDirectory();
  } catch {
    return false;
  }
}
