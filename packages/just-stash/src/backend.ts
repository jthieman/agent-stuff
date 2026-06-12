import type { IFileSystem } from "just-bash";
import type { SnapshotId, CommitInfo, CommitMetadata, DiffEntry } from "./types.ts";

/**
 * The core abstraction. A SnapshotBackend stores commits durably and
 * lets a PersistentFs restore them.
 *
 * Three reference implementations:
 *   - GitBackend  (isomorphic-git over a remote git server)
 *   - BlobBackend (tar.zst over BlobStore + MetadataStore)
 *   - MemoryBackend (BlobBackend with in-memory stores; for tests)
 *
 * Contract requirements:
 *
 *   1. commit() is atomic with CAS on prior HEAD. If priorHead doesn't
 *      match the backend's current HEAD, commit MUST throw CasConflictError
 *      and MUST NOT advance HEAD or leave the backend in a partial state.
 *
 *   2. commit() must durably persist the snapshot BEFORE returning. A
 *      successful return means the commit survives a crash of this
 *      process. (For ephemeral PersistentFs deployments, this is the
 *      whole point.)
 *
 *   3. Snapshot ids identify positions in commit history. Backends that
 *      deduplicate identical content should keep content identity separate
 *      from the commit id.
 *
 *   4. restore() into an empty fs reproduces the committed state exactly.
 *      Order of writes, mode bits, and similar details may differ; the
 *      filesystem tree must be identical.
 */
export interface SnapshotBackend {
  /**
   * Read the current HEAD snapshot id, or null if the backend has no
   * commits yet (new sandbox).
   */
  readHead(): Promise<SnapshotId | null>;

  /**
   * Restore the given snapshot into `into`. Caller is responsible for
   * clearing `into` first if a clean state is desired.
   */
  restore(snapshotId: SnapshotId, into: IFileSystem): Promise<void>;

  /**
   * Walk `fs`, build a snapshot, and advance HEAD atomically.
   *
   * - Paths matching any prefix in `excludePaths` are not included.
   * - Symlinks are NOT included in snapshots (security).
   * - Throws CasConflictError if priorHead doesn't match backend HEAD.
   * - Throws on size limit, IO failure, etc.
   *
   * Returns metadata about the new commit.
   */
  commit(opts: {
    fs: IFileSystem;
    excludePaths: string[];
    priorHead: SnapshotId | null;
    metadata: CommitMetadata;
  }): Promise<CommitInfo>;

  /**
   * Move HEAD back to a previous snapshot, atomically.
   * Throws CasConflictError if priorHead doesn't match.
   *
   * Rollback does NOT modify any filesystem — callers are expected to
   * call restore() on a freshly-cleared inner fs after.
   */
  rollback(target: SnapshotId, priorHead: SnapshotId): Promise<void>;

  /**
   * Look up a commit by snapshot id. Returns null if not found.
   *
   * Backends are expected to implement this cheaply (O(1)) since
   * `doctor` walks chains via parentId using this method.
   */
  getCommit(snapshotId: SnapshotId): Promise<CommitInfo | null>;

  /**
   * List commit history, newest first. If `limit` is omitted, returns
   * the full reachable chain.
   */
  log(opts?: { limit?: number; since?: SnapshotId }): Promise<CommitInfo[]>;

  /**
   * Diff two snapshots. Minimum granularity is path-level. Backends may
   * provide content diffs but consumers should not depend on them.
   *
   * If `to` is omitted, diffs `from` against current HEAD.
   */
  diff(from: SnapshotId, to?: SnapshotId): Promise<DiffEntry[]>;

  /**
   * Attach harness metadata to a commit (prompts, model output, run IDs).
   * Stored separately from the commit itself (e.g. git notes, or a
   * commit_notes column in metadata).
   */
  addNote(snapshotId: SnapshotId, note: string): Promise<void>;
  getNote(snapshotId: SnapshotId): Promise<string | null>;

  /**
   * Fork: produce a backend whose HEAD points at src's current HEAD,
   * sharing storage where possible.
   *
   * Backends MAY implement this natively (O(1) for git refs, metadata
   * copy for blob backends with content addressing). If not implemented,
   * PersistentFs.fork falls back to "snapshot + restore" which always
   * works but is slower.
   */
  fork?(dst: SnapshotBackend): Promise<void>;

  /**
   * Release backend resources. Does not affect durable state.
   */
  close(): Promise<void>;
}
