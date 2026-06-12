/**
 * Opaque snapshot identifier. This identifies a position in a backend's
 * commit history. For git backends, it is the commit OID.
 */
export type SnapshotId = string & { readonly __snapshotId: unique symbol };

/**
 * Opaque content identifier. Blob backends use this for the content-
 * addressed archive key, while `SnapshotId` remains the commit/timeline id.
 */
export type ContentId = string & { readonly __contentId: unique symbol };

/**
 * Metadata about a commit. Same shape regardless of backend.
 */
export interface CommitInfo {
  snapshotId: SnapshotId;
  /**
   * Content-addressed tree/archive id when it differs from the commit id.
   * BlobBackend sets this to the archive SHA-256. GitBackend leaves it unset
   * because the git commit id is enough to find the tree.
   */
  contentId?: ContentId;
  parentId: SnapshotId | null;
  trigger: string;
  message: string;
  author: { name: string; email: string };
  /** Unix millis. */
  timestamp: number;
}

/**
 * Per-commit caller metadata. Created by the caller; backends pass it through.
 */
export interface CommitMetadata {
  trigger: string;
  message: string;
  author: { name: string; email: string };
  timestamp: number;
}

/**
 * One entry in a tree diff. Backends must return at least path-level
 * granularity (added/modified/removed paths). Backends MAY return
 * additional fields (size delta, content diff, etc.) but consumers
 * should not depend on them.
 */
export interface DiffEntry {
  path: string;
  kind: "added" | "modified" | "removed";
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AgentFsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "AgentFsError";
  }
}

/**
 * Thrown when an atomic commit fails because the prior HEAD value
 * has changed on the backend (another committer raced and won).
 *
 * Callers can retry by re-walking the inner fs and committing again.
 */
export class CasConflictError extends AgentFsError {
  constructor(
    public readonly expectedHead: SnapshotId | null,
    public readonly actualHead: SnapshotId | null,
  ) {
    super(
      `Concurrent commit conflict: expected HEAD ${expectedHead ?? "(empty)"}, ` +
        `got ${actualHead ?? "(empty)"}`,
      "CAS_CONFLICT",
    );
    this.name = "CasConflictError";
  }
}

export class SnapshotNotFoundError extends AgentFsError {
  constructor(snapshotId: string) {
    super(`Snapshot not found: ${snapshotId}`, "SNAPSHOT_NOT_FOUND");
    this.name = "SnapshotNotFoundError";
  }
}

export class SnapshotSizeLimitError extends AgentFsError {
  constructor(actual: number, limit: number) {
    super(`Snapshot size ${actual} exceeds limit ${limit}`, "SNAPSHOT_SIZE_LIMIT");
    this.name = "SnapshotSizeLimitError";
  }
}
