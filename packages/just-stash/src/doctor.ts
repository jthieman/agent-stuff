import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { SnapshotBackend } from "./backend.ts";
import type { SnapshotId } from "./types.ts";
import type { BlobStore, MetadataStore } from "./stores/types.ts";

/**
 * Operational tools for keeping an just-stash deployment healthy.
 *
 * Two layers of concerns:
 *
 *   - Backend-level: orphan blob GC, integrity checks. Walks the
 *     commit chain from HEAD and identifies stored data that's no
 *     longer reachable, or commits whose data is missing.
 *
 *   - Workspace-level: stale tree directories, orphaned meta files,
 *     locks whose owner is long gone. Scans the WorkspaceManager's
 *     on-disk state and flags inconsistencies.
 *
 * All operations are read-only by default and return reports.
 * Destructive variants (`prune*`) take an explicit `apply: true`
 * to actually delete things.
 */

// =====================================================================
// Backend-level: integrity check
// =====================================================================

export interface IntegrityReport {
  headSnapshotId: SnapshotId | null;
  /** Total commits found by walking the chain from HEAD. */
  reachableCommits: number;
  /**
   * Snapshot IDs that are referenced by some commit's parentId but
   * whose own commit record doesn't exist. Indicates a broken chain.
   */
  missingCommits: SnapshotId[];
  /**
   * For BlobBackend-style storage: blob keys whose content doesn't
   * exist in the BlobStore even though the commit record references it.
   */
  missingBlobs: string[];
}

/**
 * Verify a backend's commit chain is intact: every commit's parent
 * resolves, every commit has its data, HEAD points at a real commit.
 *
 *   const report = await verifyIntegrity(backend);
 *   if (report.missingCommits.length || report.missingBlobs.length) {
 *     // backend is damaged
 *   }
 *
 * Pass `blobs` for BlobBackend deployments to check that each
 * commit's content blob still exists. Omit for git-backed deployments
 * (git's own integrity model handles that — git fsck is the right tool
 * there).
 *
 * Streams the commit chain — no full-history memory use on large repos.
 */
export async function verifyIntegrity(
  backend: SnapshotBackend,
  opts?: { blobs?: BlobStore },
): Promise<IntegrityReport> {
  const head = await backend.readHead();
  const report: IntegrityReport = {
    headSnapshotId: head,
    reachableCommits: 0,
    missingCommits: [],
    missingBlobs: [],
  };
  if (head === null) return report;

  // Walk the chain by following parentId. One getCommit call per
  // commit; no accumulation of the full history. Bounded memory
  // regardless of chain length.
  let cursor: SnapshotId | null = head;
  const seen = new Set<SnapshotId>();
  while (cursor !== null) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const c = await backend.getCommit(cursor);
    if (!c) {
      // Cursor pointed at a commit that doesn't exist
      report.missingCommits.push(cursor);
      break;
    }
    report.reachableCommits++;
    if (opts?.blobs) {
      const blobKey = c.contentId ?? c.snapshotId;
      if (!(await opts.blobs.exists(blobKey))) {
        report.missingBlobs.push(blobKey);
      }
    }
    cursor = c.parentId;
  }

  return report;
}

// =====================================================================
// Backend-level: orphan blob GC (BlobBackend only)
// =====================================================================

export interface OrphanBlobReport {
  /** All blob keys in the BlobStore. */
  totalBlobs: number;
  /** Blob keys reachable from HEAD's commit chain. */
  reachableBlobs: number;
  /** Blob keys not reachable — candidates for deletion. */
  orphanKeys: string[];
}

/**
 * Identify orphan blobs in a BlobBackend's storage: data that exists
 * in the BlobStore but isn't reachable from HEAD's commit chain.
 *
 * Orphans happen when a commit fails partway through (blob written,
 * commit metadata not), or after a rollback drops a commit from the
 * chain. They take up storage without serving any purpose.
 *
 * This is a READ operation. Use `pruneOrphanBlobs` to actually delete.
 */
export async function findOrphanBlobs(
  metadata: MetadataStore,
  blobs: BlobStore,
): Promise<OrphanBlobReport> {
  // Walk the reachable set via parentId — bounded memory.
  const reachableBlobKeys = new Set<string>();
  let hasUnknownReachableBlob = false;
  const seenCommits = new Set<SnapshotId>();
  let cursor: SnapshotId | null = await metadata.readHead();
  while (cursor !== null) {
    if (seenCommits.has(cursor)) break;
    seenCommits.add(cursor);
    const c = await metadata.getCommit(cursor);
    if (!c) break;
    if (c.contentId) {
      reachableBlobKeys.add(c.contentId);
    } else {
      hasUnknownReachableBlob = true;
    }
    cursor = c.parentId;
  }

  // Walk the blob store and identify ones not in the reachable set.
  const orphanKeys: string[] = [];
  let totalBlobs = 0;
  for await (const key of blobs.list()) {
    totalBlobs++;
    if (!hasUnknownReachableBlob && !reachableBlobKeys.has(key)) orphanKeys.push(key);
  }

  return { totalBlobs, reachableBlobs: reachableBlobKeys.size, orphanKeys };
}

/**
 * Delete orphan blobs from a BlobStore. Defaults to dry-run; pass
 * `{ apply: true }` to actually delete.
 *
 *   const report = await findOrphanBlobs(meta, blobs);
 *   if (report.orphanKeys.length > 0) {
 *     await pruneOrphanBlobs(blobs, report.orphanKeys, { apply: true });
 *   }
 *
 * Safety: this is a one-way operation. Take a backup or copy of the
 * BlobStore before running with `apply: true` in production.
 */
export async function pruneOrphanBlobs(
  blobs: BlobStore,
  keys: string[],
  opts: { apply: boolean },
): Promise<{ deleted: number; planned: number }> {
  if (!opts.apply) return { deleted: 0, planned: keys.length };
  let deleted = 0;
  for (const key of keys) {
    await blobs.delete(key);
    deleted++;
  }
  return { deleted, planned: keys.length };
}

// =====================================================================
// MetadataStore-level: orphan commit GC
//
// A commit row is "orphaned" if it exists in the MetadataStore but
// can't be reached by walking parentId from HEAD. Sources of orphans:
//   - Crash between blob.put and metadata.appendCommit (blob orphaned,
//     no commit row → not this case)
//   - Crash between commit row write and HEAD swap (commit row written,
//     HEAD didn't advance → orphan commit)
//   - Optimistic CAS losing race: commit row written, HEAD CAS fails
//     (current code does pre-flight check, but this could still happen
//     in true-race scenarios)
//   - External processes inserting commit rows without linking them
//     into HEAD's chain
//   - Manual surgery
//
// Commit orphans are cheap (a few hundred bytes per row) but they
// confuse `log()`, accumulate over time, and indicate something
// went wrong that an operator should know about.
// =====================================================================

export interface OrphanCommitReport {
  /** All commit IDs known to the metadata store. */
  totalCommits: number;
  /** Commits reachable from HEAD by walking parentId. */
  reachableCommits: number;
  /** Commit IDs not reachable from HEAD — candidates for deletion. */
  orphanIds: SnapshotId[];
}

/**
 * Identify orphan commits in a MetadataStore. Read-only — use
 * `pruneOrphanCommits` to delete.
 *
 * Works on any MetadataStore (InMemory, Sqlite, Postgres, S3).
 */
export async function findOrphanCommits(metadata: MetadataStore): Promise<OrphanCommitReport> {
  const reachable = new Set<SnapshotId>();
  let cursor: SnapshotId | null = await metadata.readHead();
  while (cursor !== null) {
    if (reachable.has(cursor)) break;
    const c = await metadata.getCommit(cursor);
    if (!c) break;
    reachable.add(c.snapshotId);
    cursor = c.parentId;
  }

  const orphanIds: SnapshotId[] = [];
  let totalCommits = 0;
  for await (const id of metadata.listCommitIds()) {
    totalCommits++;
    if (!reachable.has(id)) orphanIds.push(id);
  }

  return { totalCommits, reachableCommits: reachable.size, orphanIds };
}

/**
 * Delete orphan commits from a MetadataStore. Defaults to dry-run.
 *
 * Notes don't need a separate pruning step — `deleteCommit` removes
 * the associated note atomically.
 *
 * Safety: one-way operation. Pair with `findOrphanCommits` and
 * inspect the report before applying.
 */
export async function pruneOrphanCommits(
  metadata: MetadataStore,
  ids: SnapshotId[],
  opts: { apply: boolean },
): Promise<{ deleted: number; planned: number }> {
  if (!opts.apply) return { deleted: 0, planned: ids.length };
  let deleted = 0;
  for (const id of ids) {
    await metadata.deleteCommit(id);
    deleted++;
  }
  return { deleted, planned: ids.length };
}

// =====================================================================
// Workspace-level: stale tree directories
// =====================================================================

export interface StaleWorkspaceReport {
  /**
   * Sandboxes whose tree directory exists but whose lastActiveAt is
   * older than `staleAfterMs`. Candidates for eviction.
   */
  staleSandboxes: Array<{
    sandboxId: string;
    treePath: string;
    lastActiveAt: number;
    ageMs: number;
  }>;
  /**
   * Sandboxes that have meta files but no tree directory (cleanup
   * was partial). The meta files can be safely deleted.
   */
  orphanedMeta: string[];
  /**
   * Sandboxes that have tree directories but no meta files. This is
   * unusual — either a tree was created out-of-band or meta was lost.
   * Not deleted automatically; flagged for review.
   */
  treeWithoutMeta: string[];
}

/**
 * Scan a WorkspaceManager's root directory for stale and inconsistent
 * state. Read-only — use `manager.evict(id)` or `manager.sweep()` to
 * actually delete.
 */
export async function findStaleWorkspaces(opts: {
  managerRoot: string;
  staleAfterMs: number;
}): Promise<StaleWorkspaceReport> {
  const now = Date.now();
  const treesDir = join(opts.managerRoot, "trees");
  const metaDir = join(opts.managerRoot, "meta");

  let treeIds: string[] = [];
  let metaFiles: string[] = [];
  try {
    treeIds = await fsp.readdir(treesDir);
  } catch {}
  try {
    metaFiles = await fsp.readdir(metaDir);
  } catch {}

  const metaIds = new Set(
    metaFiles.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)),
  );
  const treeIdSet = new Set(treeIds);

  const stale: StaleWorkspaceReport["staleSandboxes"] = [];
  for (const id of treeIds) {
    if (!metaIds.has(id)) continue; // handled below
    let meta: { lastActiveAt?: number } = {};
    try {
      const text = await fsp.readFile(join(metaDir, `${id}.json`), "utf8");
      meta = JSON.parse(text);
    } catch {
      continue;
    }
    const lastActiveAt = Number(meta.lastActiveAt) || 0;
    const ageMs = now - lastActiveAt;
    if (ageMs > opts.staleAfterMs) {
      stale.push({
        sandboxId: id,
        treePath: join(treesDir, id),
        lastActiveAt,
        ageMs,
      });
    }
  }

  return {
    staleSandboxes: stale,
    orphanedMeta: [...metaIds].filter((id) => !treeIdSet.has(id)),
    treeWithoutMeta: treeIds.filter((id) => !metaIds.has(id)),
  };
}

/**
 * Delete orphaned meta files (sandboxes whose tree is already gone).
 * Safe to run anytime — these files serve no purpose without their tree.
 */
export async function pruneOrphanedMeta(opts: {
  managerRoot: string;
  apply: boolean;
}): Promise<{ deleted: number; planned: string[] }> {
  const report = await findStaleWorkspaces({
    managerRoot: opts.managerRoot,
    staleAfterMs: 0,
  });
  if (!opts.apply) return { deleted: 0, planned: report.orphanedMeta };

  const metaDir = join(opts.managerRoot, "meta");
  let deleted = 0;
  for (const id of report.orphanedMeta) {
    try {
      await fsp.rm(join(metaDir, `${id}.json`), { force: true });
      deleted++;
    } catch {
      /* skip */
    }
  }
  return { deleted, planned: report.orphanedMeta };
}
