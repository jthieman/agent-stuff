// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type { SnapshotId, ContentId, CommitInfo, CommitMetadata, DiffEntry } from "./types.ts";

export {
  AgentFsError,
  CasConflictError,
  SnapshotNotFoundError,
  SnapshotSizeLimitError,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

export type { SnapshotBackend } from "./backend.ts";

// ---------------------------------------------------------------------------
// Wrappers (all implement just-bash's IFileSystem)
// ---------------------------------------------------------------------------

export { PersistentFs } from "./wrappers/persistent-fs.ts";
export type {
  PersistentFsOptions,
  CommitOpts,
  ReconcileOutcome,
} from "./wrappers/persistent-fs.ts";

export { SizeLimitedFs } from "./wrappers/size-limited-fs.ts";
export type { SizeLimitedFsOptions } from "./wrappers/size-limited-fs.ts";

// ---------------------------------------------------------------------------
// BlobBackend + Memory stores (no peer deps; always available)
// ---------------------------------------------------------------------------

export { BlobBackend } from "./backends/blob.ts";
export type { BlobBackendOptions } from "./backends/blob.ts";

export { MemoryBackend, InMemoryBlobStore, InMemoryMetadataStore } from "./stores/memory.ts";

export type { BlobStore, MetadataStore } from "./stores/types.ts";

// ---------------------------------------------------------------------------
// Archive path safety utilities
// ---------------------------------------------------------------------------

export { resolveArchiveEntryPath, isSafeEntryType } from "./path-safety.ts";

// ---------------------------------------------------------------------------
// Walk helpers (for backends that walk the inner fs themselves)
// ---------------------------------------------------------------------------

export {
  walkSnapshot,
  isExcludedFromSnapshot,
  normalizeExcludePath,
  clearFsContents,
} from "./walk.ts";

// ---------------------------------------------------------------------------
// Disk-backed working tree + multi-sandbox pool
// ---------------------------------------------------------------------------

export { DiskWorkingTree } from "./disk/disk-working-tree.ts";
export type { DiskWorkingTreeOptions } from "./disk/disk-working-tree.ts";

export { WorkspaceManager, SandboxLockedError } from "./disk/workspace-manager.ts";
export type {
  WorkspaceManagerOptions,
  WorkspaceManagerEvents,
  SandboxConfig,
  SandboxHandle,
  EvictReason,
} from "./disk/workspace-manager.ts";

export { normalizeVirtualPath, joinToRoot, resolveRoot } from "./disk/paths.ts";

// ---------------------------------------------------------------------------
// Operational tools (doctor / GC)
// ---------------------------------------------------------------------------

export {
  verifyIntegrity,
  findOrphanBlobs,
  pruneOrphanBlobs,
  findOrphanCommits,
  pruneOrphanCommits,
  findStaleWorkspaces,
  pruneOrphanedMeta,
} from "./doctor.ts";
export type {
  IntegrityReport,
  OrphanBlobReport,
  OrphanCommitReport,
  StaleWorkspaceReport,
} from "./doctor.ts";
