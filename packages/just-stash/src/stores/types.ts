import type { SnapshotId, CommitInfo } from "../types.ts";

/**
 * Content-addressed blob storage.
 *
 * Contract:
 *   - put(content) hashes the content (SHA-256) and stores under that key
 *   - put is idempotent: same content → same key, second put is a no-op
 *   - get returns the bytes by key
 *
 * Implementations: InMemoryBlobStore, FsBlobStore, S3BlobStore, SqliteBlobStore.
 */
export interface BlobStore {
  /** Store content. Returns the SHA-256 hex digest as key. */
  put(content: Buffer): Promise<string>;
  /** Retrieve content. Throws if key not found. */
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Yield all stored keys. For GC. */
  list(): AsyncIterable<string>;
  close(): Promise<void>;
}

/**
 * Metadata storage for BlobBackend. Holds the commit chain (ref + history)
 * and any per-commit notes. Storage of the snapshot content itself is the
 * BlobStore's job.
 *
 * The commit chain is structured like a single-branch git history:
 *   - HEAD points at the latest snapshotId (or null)
 *   - Each commit has parentId pointing at the previous
 *   - History is append-only — never modify existing rows
 *
 * Implementations: InMemoryMetadataStore, SqliteMetadataStore,
 * PostgresMetadataStore, D1MetadataStore.
 */
export interface MetadataStore {
  /** Read current HEAD. */
  readHead(): Promise<SnapshotId | null>;

  /**
   * Append a commit and advance HEAD atomically, conditional on
   * priorHead matching the current HEAD. Throws CasConflictError on
   * mismatch.
   */
  appendCommit(opts: { commit: CommitInfo; priorHead: SnapshotId | null }): Promise<void>;

  /**
   * Move HEAD to a previous snapshot, conditional on priorHead matching.
   * Throws CasConflictError on mismatch.
   *
   * History rows are not removed — only the HEAD pointer changes.
   */
  setHead(target: SnapshotId, priorHead: SnapshotId): Promise<void>;

  /**
   * Read a commit's metadata by id. Returns null if not found.
   */
  getCommit(snapshotId: SnapshotId): Promise<CommitInfo | null>;

  /**
   * Walk the commit chain from current HEAD backward through parents.
   * Newest first. Stops at `since` if provided. If `limit` is omitted,
   * returns the full reachable chain.
   */
  log(opts?: { limit?: number; since?: SnapshotId }): Promise<CommitInfo[]>;

  /** Attach a note to a commit. Idempotent (overwrites). */
  putNote(snapshotId: SnapshotId, note: string): Promise<void>;
  getNote(snapshotId: SnapshotId): Promise<string | null>;

  /**
   * Yield every commit's snapshotId known to the store, in unspecified
   * order. Used by `doctor` to detect orphan commits (commits that
   * exist in storage but aren't reachable from HEAD's chain).
   */
  listCommitIds(): AsyncIterable<SnapshotId>;

  /**
   * Remove a commit's metadata. Caller is responsible for ensuring
   * the commit is not reachable from HEAD or any other reference —
   * `doctor.pruneOrphanCommits` does that check.
   *
   * Also removes any associated note. Idempotent: deleting a non-
   * existent commit is not an error.
   */
  deleteCommit(snapshotId: SnapshotId): Promise<void>;

  close(): Promise<void>;
}
