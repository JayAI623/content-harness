import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface OpencliTwitterSearchResult {
  id: string;
  author: string;
  url: string;
  content: string;
  engagement?: { likes?: number; retweets?: number; replies?: number; views?: number };
}

export interface OpencliClient {
  twitterSearch(query: string, limit?: number): Promise<OpencliTwitterSearchResult[]>;
}

export function makeOpencliSubprocessClient(opts: { bin?: string } = {}): OpencliClient {
  const bin = opts.bin ?? "opencli";
  return {
    async twitterSearch(query: string, limit = 20): Promise<OpencliTwitterSearchResult[]> {
      const { stdout } = await execFileAsync(bin, [
        "twitter", "search",
        "--query", query,
        "--limit", String(limit),
        "--json",
      ]);
      const parsed = JSON.parse(stdout) as unknown;
      if (!Array.isArray(parsed)) throw new Error("opencli twitter search did not return an array");
      return parsed as OpencliTwitterSearchResult[];
    },
  };
}

export function fakeOpencliClient(fixtures: { [query: string]: OpencliTwitterSearchResult[] }): OpencliClient {
  return {
    async twitterSearch(query: string): Promise<OpencliTwitterSearchResult[]> {
      const hit = fixtures[query] ?? Object.values(fixtures)[0] ?? [];
      return hit;
    },
  };
}
