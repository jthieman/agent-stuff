import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryFs } from "just-bash";
import {
  InMemoryBlobStore,
  InMemoryMetadataStore,
  MemoryBackend,
  BlobBackend,
} from "../src/index.ts";
import { PersistentFs } from "../src/wrappers/persistent-fs.ts";
import {
  verifyIntegrity,
  findOrphanBlobs,
  pruneOrphanBlobs,
  findOrphanCommits,
  pruneOrphanCommits,
  findStaleWorkspaces,
  pruneOrphanedMeta,
} from "../src/doctor.ts";
import { WorkspaceManager } from "../src/disk/workspace-manager.ts";

describe("doctor: verifyIntegrity", () => {
  it("empty backend reports zero commits, no issues", async () => {
    const backend = new MemoryBackend();
    const report = await verifyIntegrity(backend);
    expect(report.headSnapshotId).toBeNull();
    expect(report.reachableCommits).toBe(0);
    expect(report.missingCommits).toEqual([]);
    expect(report.missingBlobs).toEqual([]);
  });

  it("healthy chain reports all commits reachable", async () => {
    const backend = new MemoryBackend();
    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(`/file${i}.txt`, `v${i}`);
      await fs.commit({ trigger: `c${i}` });
    }
    const report = await verifyIntegrity(backend);
    expect(report.reachableCommits).toBe(5);
    expect(report.missingCommits).toEqual([]);
  });

  it("integrity check with blobs detects missing blobs", async () => {
    const blobs = new InMemoryBlobStore();
    const metadata = new InMemoryMetadataStore();
    const backend = new BlobBackend({ blobs, metadata });
    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();
    await fs.writeFile("/x.txt", "x");
    const c = await fs.commit({ trigger: "turn_end" });

    // Manually corrupt: delete the blob
    const blobKey = c.contentId ?? c.snapshotId;
    await blobs.delete(blobKey);

    const report = await verifyIntegrity(backend, { blobs });
    expect(report.missingBlobs).toContain(blobKey);
  });
});

describe("doctor: orphan blob GC", () => {
  it("no orphans in a clean backend", async () => {
    const blobs = new InMemoryBlobStore();
    const metadata = new InMemoryMetadataStore();
    const backend = new BlobBackend({ blobs, metadata });
    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();
    await fs.writeFile("/x.txt", "x");
    await fs.commit({ trigger: "turn_end" });

    const report = await findOrphanBlobs({ metadataStores: [metadata], blobs });
    expect(report.totalBlobs).toBe(1);
    expect(report.reachableBlobs).toBe(1);
    expect(report.orphanKeys).toEqual([]);
  });

  it("rollback creates orphans (former HEAD no longer reachable)", async () => {
    const blobs = new InMemoryBlobStore();
    const metadata = new InMemoryMetadataStore();
    const backend = new BlobBackend({ blobs, metadata });
    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();

    await fs.writeFile("/v.txt", "v1");
    const c1 = await fs.commit({ trigger: "t1" });
    await fs.writeFile("/v.txt", "v2");
    const c2 = await fs.commit({ trigger: "t2" });

    // Rollback to c1 — c2's blob is now orphaned
    await fs.rollback(c1.snapshotId);

    const report = await findOrphanBlobs({ metadataStores: [metadata], blobs });
    expect(report.orphanKeys).toContain(c2.contentId ?? c2.snapshotId);
    expect(report.reachableBlobs).toBe(1); // just c1
  });

  it("prune (apply: false) reports without deleting", async () => {
    const blobs = new InMemoryBlobStore();
    const metadata = new InMemoryMetadataStore();
    const backend = new BlobBackend({ blobs, metadata });
    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();
    await fs.writeFile("/x.txt", "x");
    const c1 = await fs.commit({ trigger: "t1" });
    await fs.writeFile("/x.txt", "y");
    const c2 = await fs.commit({ trigger: "t2" });
    await fs.rollback(c1.snapshotId);

    const report = await findOrphanBlobs({ metadataStores: [metadata], blobs });
    const dryRun = await pruneOrphanBlobs(blobs, report.orphanKeys, { apply: false });
    expect(dryRun.deleted).toBe(0);
    expect(dryRun.planned).toBe(report.orphanKeys.length);
    // Orphan still in store
    expect(await blobs.exists(c2.contentId ?? c2.snapshotId)).toBe(true);
  });

  it("prune (apply: true) actually deletes orphans", async () => {
    const blobs = new InMemoryBlobStore();
    const metadata = new InMemoryMetadataStore();
    const backend = new BlobBackend({ blobs, metadata });
    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();
    await fs.writeFile("/x.txt", "x");
    const c1 = await fs.commit({ trigger: "t1" });
    await fs.writeFile("/x.txt", "y");
    const c2 = await fs.commit({ trigger: "t2" });
    await fs.rollback(c1.snapshotId);

    const report = await findOrphanBlobs({ metadataStores: [metadata], blobs });
    await pruneOrphanBlobs(blobs, report.orphanKeys, { apply: true });

    expect(await blobs.exists(c2.contentId ?? c2.snapshotId)).toBe(false);
    expect(await blobs.exists(c1.contentId ?? c1.snapshotId)).toBe(true);

    // Re-running findOrphanBlobs shows zero orphans
    const after = await findOrphanBlobs({ metadataStores: [metadata], blobs });
    expect(after.orphanKeys).toEqual([]);
  });

  it("keeps blobs reachable from any metadata store sharing the blob namespace", async () => {
    const blobs = new InMemoryBlobStore();
    const metadataA = new InMemoryMetadataStore();
    const metadataB = new InMemoryMetadataStore();
    const fsA = new PersistentFs(new InMemoryFs(), {
      backend: new BlobBackend({ blobs, metadata: metadataA }),
    });
    const fsB = new PersistentFs(new InMemoryFs(), {
      backend: new BlobBackend({ blobs, metadata: metadataB }),
    });

    await fsA.boot();
    await fsA.writeFile("/a.txt", "a1");
    const a1 = await fsA.commit({ trigger: "a1" });
    await fsA.writeFile("/a.txt", "a2");
    const a2 = await fsA.commit({ trigger: "a2" });
    await fsA.rollback(a1.snapshotId);

    await fsB.boot();
    await fsB.writeFile("/b.txt", "b1");
    const b1 = await fsB.commit({ trigger: "b1" });

    const report = await findOrphanBlobs({ metadataStores: [metadataA, metadataB], blobs });
    expect(report.orphanKeys).toContain(a2.contentId ?? a2.snapshotId);
    expect(report.orphanKeys).not.toContain(a1.contentId ?? a1.snapshotId);
    expect(report.orphanKeys).not.toContain(b1.contentId ?? b1.snapshotId);
    expect(report.reachableBlobs).toBe(2);
  });

  it("does not mark blobs orphaned when a reachable legacy commit has null contentId", async () => {
    const metadata = new InMemoryMetadataStore();
    const blobs = new InMemoryBlobStore();
    await blobs.put(Buffer.from("possibly reachable legacy content"));
    await blobs.put(Buffer.from("unlinked content"));
    await metadata.appendCommit({
      commit: {
        snapshotId: "legacy-commit" as any,
        parentId: null,
        trigger: "legacy",
        message: "legacy",
        author: { name: "a", email: "a@b" },
        timestamp: 1,
      },
      priorHead: null,
    });

    const report = await findOrphanBlobs({ metadataStores: [metadata], blobs });
    expect(report.totalBlobs).toBe(2);
    expect(report.reachableBlobs).toBe(0);
    expect(report.orphanKeys).toEqual([]);
  });
});

describe("doctor: orphan commit GC", () => {
  it("no orphans in a clean store", async () => {
    const metadata = new InMemoryMetadataStore();
    const blobs = new InMemoryBlobStore();
    const backend = new BlobBackend({ blobs, metadata });
    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();
    await fs.writeFile("/x.txt", "x");
    await fs.commit({ trigger: "t" });

    const report = await findOrphanCommits(metadata);
    expect(report.totalCommits).toBe(1);
    expect(report.reachableCommits).toBe(1);
    expect(report.orphanIds).toEqual([]);
  });

  it("rollback orphans former HEAD commit", async () => {
    const metadata = new InMemoryMetadataStore();
    const blobs = new InMemoryBlobStore();
    const backend = new BlobBackend({ blobs, metadata });
    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();

    await fs.writeFile("/v.txt", "v1");
    const c1 = await fs.commit({ trigger: "t1" });
    await fs.writeFile("/v.txt", "v2");
    const c2 = await fs.commit({ trigger: "t2" });

    // Rollback: HEAD now at c1, but c2's commit row remains
    await fs.rollback(c1.snapshotId);

    const report = await findOrphanCommits(metadata);
    expect(report.orphanIds).toContain(c2.snapshotId);
    expect(report.reachableCommits).toBe(1);
  });

  it("manually-inserted unlinked commit shows as orphan", async () => {
    const metadata = new InMemoryMetadataStore();
    // Insert an unlinked commit directly. (Simulates an external process
    // that wrote a row but never advanced HEAD.)
    // Note: appendCommit advances HEAD, so we have to use it differently.
    // First a real commit, then a "rolled-back" one above it:
    await metadata.appendCommit({
      commit: {
        snapshotId: "real" as any,
        parentId: null,
        trigger: "t",
        message: "m",
        author: { name: "a", email: "a@b" },
        timestamp: 1000,
      },
      priorHead: null,
    });
    await metadata.appendCommit({
      commit: {
        snapshotId: "unlinked" as any,
        parentId: "real" as any,
        trigger: "t",
        message: "m",
        author: { name: "a", email: "a@b" },
        timestamp: 2000,
      },
      priorHead: "real" as any,
    });
    // Move HEAD back to 'real' (rollback semantics)
    await metadata.setHead("real" as any, "unlinked" as any);

    const report = await findOrphanCommits(metadata);
    expect(report.orphanIds).toContain("unlinked" as any);
  });

  it("stops walking cyclic commit chains", async () => {
    const metadata = new InMemoryMetadataStore();
    await metadata.appendCommit({
      commit: {
        snapshotId: "loop" as any,
        parentId: "loop" as any,
        trigger: "t",
        message: "m",
        author: { name: "a", email: "a@b" },
        timestamp: 1000,
      },
      priorHead: null,
    });

    const report = await findOrphanCommits(metadata);
    expect(report.reachableCommits).toBe(1);
    expect(report.orphanIds).toEqual([]);
  });

  it("prune (apply: false) does not delete", async () => {
    const metadata = new InMemoryMetadataStore();
    const blobs = new InMemoryBlobStore();
    const backend = new BlobBackend({ blobs, metadata });
    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();
    await fs.writeFile("/v.txt", "v1");
    const c1 = await fs.commit({ trigger: "t1" });
    await fs.writeFile("/v.txt", "v2");
    const c2 = await fs.commit({ trigger: "t2" });
    await fs.rollback(c1.snapshotId);

    const report = await findOrphanCommits(metadata);
    const dry = await pruneOrphanCommits(metadata, report.orphanIds, { apply: false });
    expect(dry.deleted).toBe(0);
    expect(dry.planned).toBe(report.orphanIds.length);
    // Commit row still in store
    expect(await metadata.getCommit(c2.snapshotId)).not.toBeNull();
  });

  it("prune (apply: true) deletes commit + associated note", async () => {
    const metadata = new InMemoryMetadataStore();
    const blobs = new InMemoryBlobStore();
    const backend = new BlobBackend({ blobs, metadata });
    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();
    await fs.writeFile("/v.txt", "v1");
    const c1 = await fs.commit({ trigger: "t1" });
    await fs.writeFile("/v.txt", "v2");
    const c2 = await fs.commit({ trigger: "t2", note: "about to be orphaned" });
    await fs.rollback(c1.snapshotId);

    const report = await findOrphanCommits(metadata);
    await pruneOrphanCommits(metadata, report.orphanIds, { apply: true });

    expect(await metadata.getCommit(c2.snapshotId)).toBeNull();
    expect(await metadata.getNote(c2.snapshotId)).toBeNull();
    // c1 untouched
    expect(await metadata.getCommit(c1.snapshotId)).not.toBeNull();

    const after = await findOrphanCommits(metadata);
    expect(after.orphanIds).toEqual([]);
  });

  it("listCommitIds yields all stored commit ids", async () => {
    const metadata = new InMemoryMetadataStore();
    for (let i = 0; i < 3; i++) {
      await metadata.appendCommit({
        commit: {
          snapshotId: `c${i}` as any,
          parentId: i === 0 ? null : (`c${i - 1}` as any),
          trigger: "t",
          message: "m",
          author: { name: "a", email: "a@b" },
          timestamp: i,
        },
        priorHead: i === 0 ? null : (`c${i - 1}` as any),
      });
    }
    const ids: string[] = [];
    for await (const id of metadata.listCommitIds()) ids.push(id);
    expect(ids.sort()).toEqual(["c0", "c1", "c2"]);
  });

  it("deleteCommit also removes any associated note", async () => {
    const metadata = new InMemoryMetadataStore();
    await metadata.appendCommit({
      commit: {
        snapshotId: "sha1" as any,
        parentId: null,
        trigger: "t",
        message: "m",
        author: { name: "a", email: "a@b" },
        timestamp: 1000,
      },
      priorHead: null,
    });
    await metadata.putNote("sha1" as any, "goes with the commit");
    await metadata.deleteCommit("sha1" as any);
    expect(await metadata.getCommit("sha1" as any)).toBeNull();
    expect(await metadata.getNote("sha1" as any)).toBeNull();
  });
});

describe("doctor: workspace cleanup", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "just-stash-doctor-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds stale workspaces older than threshold", async () => {
    // Construct meta + tree directories directly
    mkdirSync(join(root, "trees", "old"), { recursive: true });
    mkdirSync(join(root, "trees", "fresh"), { recursive: true });
    mkdirSync(join(root, "meta"), { recursive: true });
    const longAgo = Date.now() - 60 * 60 * 1000; // 1h ago
    const now = Date.now();
    writeFileSync(
      join(root, "meta", "old.json"),
      JSON.stringify({ lastBootedHead: null, lastActiveAt: longAgo, createdAt: longAgo }),
    );
    writeFileSync(
      join(root, "meta", "fresh.json"),
      JSON.stringify({ lastBootedHead: null, lastActiveAt: now, createdAt: now }),
    );

    const report = await findStaleWorkspaces({
      managerRoot: root,
      staleAfterMs: 30 * 60 * 1000, // 30min
    });
    expect(report.staleSandboxes.map((s) => s.sandboxId)).toEqual(["old"]);
  });

  it("identifies orphaned meta files (meta without tree)", async () => {
    mkdirSync(join(root, "meta"), { recursive: true });
    mkdirSync(join(root, "trees"), { recursive: true });
    writeFileSync(
      join(root, "meta", "ghost.json"),
      JSON.stringify({ lastActiveAt: Date.now(), createdAt: Date.now() }),
    );
    // No corresponding tree directory

    const report = await findStaleWorkspaces({
      managerRoot: root,
      staleAfterMs: Number.MAX_SAFE_INTEGER,
    });
    expect(report.orphanedMeta).toContain("ghost");
  });

  it("identifies trees without meta (manual creation, lost meta)", async () => {
    mkdirSync(join(root, "trees", "mystery"), { recursive: true });
    mkdirSync(join(root, "meta"), { recursive: true });
    // No meta file for mystery

    const report = await findStaleWorkspaces({
      managerRoot: root,
      staleAfterMs: Number.MAX_SAFE_INTEGER,
    });
    expect(report.treeWithoutMeta).toContain("mystery");
  });

  it("pruneOrphanedMeta (apply: true) deletes orphan meta files", async () => {
    mkdirSync(join(root, "meta"), { recursive: true });
    mkdirSync(join(root, "trees"), { recursive: true });
    writeFileSync(join(root, "meta", "ghost.json"), "{}");
    writeFileSync(join(root, "meta", "real.json"), "{}");
    mkdirSync(join(root, "trees", "real"));

    const result = await pruneOrphanedMeta({ managerRoot: root, apply: true });
    expect(result.planned).toContain("ghost");
    expect(result.deleted).toBe(1);
  });

  it("integrates with WorkspaceManager evict for the full cycle", async () => {
    const manager = new WorkspaceManager({
      root,
      defaults: { backendFactory: () => new MemoryBackend() },
      ttlMs: 60_000,
    });

    const h = await manager.acquire("alice");
    await h.release();
    // Simulate aging: rewrite meta with old timestamp
    const metaPath = join(root, "meta", "alice.json");
    const meta = JSON.parse(require("node:fs").readFileSync(metaPath, "utf8"));
    meta.lastActiveAt = Date.now() - 60 * 60 * 1000;
    require("node:fs").writeFileSync(metaPath, JSON.stringify(meta));

    const report = await findStaleWorkspaces({
      managerRoot: root,
      staleAfterMs: 30 * 60 * 1000,
    });
    expect(report.staleSandboxes.length).toBe(1);
    expect(report.staleSandboxes[0].sandboxId).toBe("alice");

    // Use the manager to actually evict
    await manager.evict("alice");
    const after = await findStaleWorkspaces({
      managerRoot: root,
      staleAfterMs: 0,
    });
    expect(after.staleSandboxes.length).toBe(0);

    await manager.close();
  });
});
