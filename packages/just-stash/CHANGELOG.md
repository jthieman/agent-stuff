# Changelog

## 0.6.0 — 2026-06-13

### Breaking

- **Package renamed from `agent-fs` to `just-stash`.** The old name was too generic for a library tightly bound to just-bash. `just-stash` signals the just-bash family, uses git's "stash" metaphor that maps naturally onto commit/rollback/fork, and reads consistently with the storage-system subpaths (`just-stash/git`, `just-stash/blob`, `just-stash/s3`, `just-stash/cloudflare`).
- Subpath imports: `agent-fs/git` → `just-stash/git`, etc.
- Default Postgres table prefix: `agent_fs_` → `just_stash_`. Override via `PostgresMetadataStoreOptions.tablePrefix` if you've already deployed.
- Integration tests now run as part of the normal test suite instead of being gated behind an environment variable.

## 0.5.0 — unreleased

### Added

- **Cloudflare Artifacts integration** at `just-stash/cloudflare`. `CloudflareArtifacts` is a REST client for the Artifacts management plane (create / list / get / delete repos, server-side fork, import from public HTTPS, mint / list / revoke tokens). The high-level `createBackend(name, { cacheDir })` ensures the repo exists, mints a fresh token, and returns a `GitBackend` pre-configured for the data plane. Slots into `WorkspaceManager` via `backendFactory`. No new runtime dependencies — uses `fetch` and the existing `GitBackend`.
- **Real cross-process locking** in `WorkspaceManager` — pure Node, zero new dependencies. Uses atomic `open('wx')` for lock creation, a PID + nonce file body, a 30-second mtime heartbeat for liveness, and a 90-second TTL with PID-liveness check for stale-lock reclaim. **Opt-in via `crossProcessLocking: true`, default off** — the default optimizes for the common single-process case. Multi-process deployments (a second harness against the same root, deploy-overlap, sidecar tooling) MUST set this flag or they will silently corrupt sandboxes.
- **Typed events on `WorkspaceManager`**. The class extends `EventEmitter` and emits `acquire`, `release`, `evict`, and `sweep` events. `WorkspaceManagerEvents` is exported as a typed interface so consumers get fully-typed callbacks.
- **`PersistentFs.reconcile(error)`** — recovery helper for the "commit threw but maybe succeeded" case. Returns a structured outcome: `{ kind: 'conflict', actualHead }` for CAS conflicts, `{ kind: 'observed', currentHead }` for other errors. Callers compare `currentHead` against their last-known-good to determine whether to retry.
- **`SnapshotBackend.getCommit(snapshotId)`** added to the interface. Both backends implement it cheaply. Lets `doctor` walk commit chains by `parentId` instead of pulling full histories into memory.
- **Streaming chain walks in `doctor`** — `verifyIntegrity`, `findOrphanBlobs`, `findOrphanCommits` now bound memory at one commit at a time regardless of chain length.

### Fixed

- **Non-deterministic walk ordering.** `walkSnapshot` was relying on filesystem-dependent `readdir` order, which breaks content-addressed snapshot dedup on filesystems that don't return sorted entries (ext4 with large directories, XFS, NFS). `walkSnapshot` now sorts entries lexically before iterating.
- **Slow `boot()` on disk-backed trees.** `PersistentFs.boot()` walked the tree via `readdir` + `rm` (one syscall per entry) instead of using `DiskWorkingTree.clear()`'s recursive remove. Now uses the inner's `clear()` method when present.
- **Remote-backed `GitBackend` refresh.** Long-lived remote-backed caches fetch the current branch before `readHead()`/`boot()`, and git notes under `refs/notes/just-stash` are pushed/fetched with the remote instead of remaining local-cache-only.

### Documentation

- **New `docs/integration.md`** — developer-facing guide for using just-stash in an application. Covers the mental model (app vs. just-stash vs. backend), what to store in your app DB vs. what just-stash stores, the standard acquire/use/release lifecycle, five concrete integration patterns (one workspace per conversation, one per user, branching, pinned snapshots, history rendering), how to persist snapshotIds for app-level features (undo stacks, named bookmarks, diff-against-baseline), how to implement a custom backend (with `BlobBackend` and `GitBackend` as references), and common pitfalls.
- README, architecture.md, and AGENTS.md updated to reflect cross-process locks, events, reconcile pattern, and known edge cases (case-insensitive filesystems, Unicode normalization).

### Testing

- **Integration tests** added against real Postgres, real S3 (via MinIO), and real Gitea (HTTP smart-protocol git remote) using `testcontainers`. They run as part of the normal package test suite and require Docker. Cover the exact wire shapes that in-memory fakes can't: `SELECT FOR UPDATE` serialization in real Postgres, `If-Match` / `If-None-Match` semantics against the real S3 protocol, isomorphic-git push/fetch against a real HTTP git server (token auth, server-side ref checks, fresh-cache fetch-and-restore), error-shape verification (`412 PreconditionFailed` → `CasConflictError`), pagination, concurrent-push rejection by the server, and full end-to-end commit/rollback/doctor cycles against real services.
- New script: `pnpm test:integration`. Documented in README under "Testing."

## 0.4.1 — unreleased

### Added

- **`findOrphanCommits` / `pruneOrphanCommits`** in `just-stash/doctor`. Works on any `MetadataStore`: finds commit rows not reachable from HEAD's chain (rollback survivors, partial-commit residue, externally-inserted unlinked commits).
- **`MetadataStore.listCommitIds()` and `MetadataStore.deleteCommit()`** are now part of the interface. Implementations added to `InMemoryMetadataStore`, `SqliteStore`, `PostgresMetadataStore` (Postgres uses a cursor for memory-safe streaming). `S3MetadataStore` already had them.

### Notes

- Postgres optimistic CAS via `UPDATE ... WHERE` was considered as an alternative to the current `SELECT ... FOR UPDATE` pattern. We left the code as-is — pgbouncer concerns don't apply to our deployment shape and the pessimistic version has no orphan-commit window. Documented in architecture.md.

## 0.4.0 — unreleased

### Added

- **`S3MetadataStore`** — `MetadataStore` implementation using S3 conditional writes (`If-Match` etags, `If-None-Match: "*"`) for atomic CAS. Enables S3-only deployments — pair with `S3BlobStore` for a backend that needs nothing but an S3-compatible bucket. Works on AWS S3 (post-2024 conditional writes), Cloudflare R2, Tigris, MinIO.
- **`just-stash/doctor`** — operational tooling: `verifyIntegrity` (walk commit chain, check linkage), `findOrphanBlobs` / `pruneOrphanBlobs` (GC unreachable data), `findStaleWorkspaces` / `pruneOrphanedMeta` (clean up workspace manager state).
- **`S3BlobStore.put` uses `If-None-Match: "*"`** for single-round-trip idempotent puts. Closes a TOCTOU race window in the previous head-then-put pattern.
- 28 new tests (16 doctor + 12 S3MetadataStore via in-memory S3 fake).

### Notes

- Inspired by [git-remote-s3](https://github.com/awslabs/git-remote-s3)'s S3 conditional-write CAS model.

## 0.3.0 — unreleased

### Added

- **`DiskWorkingTree`** — `IFileSystem` backed by a real on-disk directory with strict sandbox isolation. Rejects `..` traversal, absolute-path injection, symlinks that escape the root, null bytes, and Windows-style separators. Pre-existing symlinks at any path component are not followed.
- **`WorkspaceManager`** — pool of disk-backed sandboxes for multi-tenant harnesses. TTL eviction, disk-budget eviction, single-writer locks (in-process), per-sandbox tree/cache/meta directories under one root.
- **Warm-boot optimization** — `WorkspaceManager.acquire()` persists `lastBootedHead` per sandbox. Re-acquiring a sandbox whose tree already matches backend HEAD skips the restore walk entirely.
- **25 escape-prevention tests** documenting the security guarantees of `DiskWorkingTree`.
- **17 WorkspaceManager tests** covering acquire/release, lifecycle, eviction, ID validation, warm boot, and inter-sandbox isolation.

### Notes

- Cross-process locking (flock) deferred. Documented as harness responsibility for v1.
- Recommended production shape is now `WorkspaceManager + DiskWorkingTree + GitBackend` (or `BlobBackend`). InMemoryFs is for tests.

## 0.2.0

### Breaking

- Complete rewrite around the `SnapshotBackend` abstraction.
- Single package `just-stash` with subpath exports.
- `PersistentFs` API is session-less; one backend per instance.

### Added

- `GitBackend` (isomorphic-git, optional remote sync, native fork).
- `BlobBackend` (tar.zst over `BlobStore` + `MetadataStore`).
- `MemoryBackend` with `cloneHandle()`.
- `SqliteStore` implementing both `BlobStore` and `MetadataStore`.
- `S3BlobStore`, `PostgresMetadataStore`.
- `excludeFromSnapshots` for scratch directories.
- `addNote`/`getNote` (git: `refs/notes/just-stash`; blob: notes table).
- Slash commands via `just-stash/pi`.

### Removed

- Multi-package monorepo layout.
- Custom VFS implementations.
- Session-ID-based API.
- `maxHistoryLength`, `autoGc`.

## 0.1.0 — superseded

Initial multi-package release, replaced wholesale by 0.2.0.
