import { describe, it, expect } from "vite-plus/test";
import { InMemoryFs } from "just-bash";
import { BlobBackend } from "../src/backends/blob.ts";
import { InMemoryBlobStore } from "../src/stores/memory.ts";
import type { CommitInfo } from "../src/types.ts";

describe("BlobBackend", () => {
  it("uses distinct commit ids for identical same-millisecond commits", async () => {
    const commits: CommitInfo[] = [];
    const backend = new BlobBackend({
      blobs: new InMemoryBlobStore(),
      metadata: {
        appendCommit: async ({ commit }: { commit: CommitInfo }) => {
          commits.push(commit);
        },
      } as any,
    });
    const fs = new InMemoryFs({ "/same.txt": "same" });
    const metadata = {
      trigger: "turn_end",
      message: "turn_end",
      author: { name: "agent", email: "agent@example.com" },
      timestamp: 1_000,
    };

    const c1 = await backend.commit({ fs, excludePaths: [], priorHead: null, metadata });
    const c2 = await backend.commit({ fs, excludePaths: [], priorHead: null, metadata });

    expect(c1.contentId).toBe(c2.contentId);
    expect(c1.snapshotId).not.toBe(c2.snapshotId);
    expect(commits.map((commit) => commit.snapshotId)).toEqual([c1.snapshotId, c2.snapshotId]);
  });
});
