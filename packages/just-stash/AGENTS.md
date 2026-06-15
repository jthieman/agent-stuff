# AGENTS.md

## Project overview

just-stash is the persistence layer for a multi-sandbox agent harness. It wraps [just-bash](https://github.com/just-bash/just-bash) `IFileSystem` instances with restore/commit/rollback/fork against durable storage, and provides a pool manager for running many sandboxes per machine with TTL eviction and disk budgeting.

just-bash is a sandboxed bash interpreter — its commands run in-process JS, no subprocesses. Our entire security model is "the IFileSystem boundary is the boundary."

Docs hierarchy:

- `README.md` — API reference
- `docs/integration.md` — developer-facing guide: lifecycle patterns, what to store in app DB, custom backend implementation guide. Point new integrators here.
- `docs/architecture.md` — internals, design decisions, CAS mechanisms, locking protocol
- This file — invariants and conventions for agents working on just-stash itself

## Package structure

Single package, multiple subpath exports:

```
packages/just-stash/
├── package.json          subpath exports: ".", "./git", "./blob", "./sqlite", "./postgres", "./s3", "./pi"
├── src/
│   ├── index.ts          main exports
│   ├── types.ts          SnapshotId, CommitInfo, errors (CasConflictError is load-bearing)
│   ├── backend.ts        SnapshotBackend interface
│   ├── walk.ts           shared walkSnapshot / clearFsContents
│   ├── path-safety.ts    archive entry path validation (tar extraction)
│   ├── pi.ts             /snapshot, /snapshots, /rollback
│   ├── doctor.ts         operational tools: verifyIntegrity, findOrphanBlobs, findStaleWorkspaces
│   ├── cloudflare-artifacts.ts  REST client + GitBackend helper for Cloudflare Artifacts
│   ├── wrappers/
│   │   ├── persistent-fs.ts   thin SnapshotBackend wrapper
│   │   └── size-limited-fs.ts byte and entry caps
│   ├── disk/
│   │   ├── paths.ts             path normalization and escape rejection
│   │   ├── disk-working-tree.ts IFileSystem over a real directory with strict isolation
│   │   └── workspace-manager.ts pool, TTL eviction, single-writer locks, disk budget
│   ├── backends/
│   │   ├── blob.ts       tar.zst over BlobStore + MetadataStore
│   │   └── git.ts        isomorphic-git over a bare repo, optional remote sync
│   └── stores/
│       ├── types.ts      BlobStore + MetadataStore interfaces
│       ├── memory.ts     InMemoryBlobStore, InMemoryMetadataStore, MemoryBackend
│       ├── sqlite.ts     SqliteStore (both interfaces)
│       ├── postgres.ts   PostgresMetadataStore
│       ├── s3.ts         S3BlobStore (re-exports S3MetadataStore)
│       └── s3-metadata.ts S3MetadataStore (S3-only CAS via conditional writes)
```

## Conventions

- TypeScript, ESM only, `nodenext` module resolution
- All source files use `.ts` extension in imports (TS 5+ requirement)
- Build with `vp pack`; package entries are configured in `vite.config.ts`
- Test with `vp test` and import test helpers from `vite-plus/test`
- Imports inside `wrappers/`, `backends/`, `stores/`, `disk/` use `../` to reach top-level modules

## Key design invariants

1. **IFileSystem IS the security boundary.** just-bash has no subprocesses; everything that touches files goes through IFileSystem. DiskWorkingTree must reject all escape attempts at this layer: `..`, absolute-path injection (via the join), pre-existing symlinks, encoded paths, null bytes.

2. **One backend per sandbox.** No branches, no per-session multiplexing. Forks are separate backends.

3. **Inner fs is restorable to empty.** `PersistentFs.boot()` clears the inner first (using `inner.clear()` if available, else walks via IFileSystem). Safe because inner is either `InMemoryFs` (process-owned) or `DiskWorkingTree` (manager-owned). Don't wrap a host directory you care about.

4. **`commit()` IS the push.** When it returns, the snapshot is durable. No background sync.

5. **Backend-owned walk.** Each backend walks the inner fs itself via the shared `walkSnapshot` helper.

6. **CAS on every commit and rollback.** Throw `CasConflictError` on prior-head mismatch.

7. **Commit identity is not content identity.** `SnapshotId` identifies a position in commit history. Blob backends keep the archive hash in `contentId` so no-op commits can advance the chain while deduping content.

8. **Deterministic archive bytes.** Tar entries get `mtime: new Date(0)`. `walkSnapshot` sorts directory entries lexically before iterating — POSIX doesn't guarantee `readdir` order and we can't rely on it for content addressing.

9. **`excludeFromSnapshots` is path-prefix on the snapshot walk.** It does not hide paths from the agent; it only controls what goes into committed snapshots.

10. **WorkspaceManager enforces single-writer-per-sandbox at two layers.** In-process via a synchronously-modified `pending` set + the `active` Map (always on, closes the await-yield race). Cross-process via a lockfile (`open('wx')` + PID + mtime heartbeat + 90s TTL with PID-liveness reclaim) is **opt-in via `crossProcessLocking: true`, default off**. The default optimizes for the common single-process case; multi-process deployments must opt in.

11. **`SnapshotBackend.getCommit` must be cheap.** Used by `doctor` to walk chains by `parentId` in bounded memory. Implementations should look up a single commit in O(1) or close to it.

12. **`PersistentFs.reconcile(error)` is the recovery surface.** Don't add per-call retry logic inside backends. If commit fails ambiguously, surface the error; let the caller use `reconcile` to determine state.

## Adding a backend

1. Implement `SnapshotBackend` (in `src/backend.ts`).
2. Walk the inner fs via `walkSnapshot` from `src/walk.ts`.
3. Throw `CasConflictError` on prior-head mismatch.
4. Add tests that exercise the contract via `PersistentFs`.

## Adding a BlobStore / MetadataStore

Implement the interface in `src/stores/types.ts` and pair with `BlobBackend`:

```typescript
new BlobBackend({ blobs: myBlobStore, metadata: myMetadataStore });
```

Guarantees:

- BlobStore: `put` is content-addressed (SHA-256), idempotent.
- MetadataStore: `appendCommit` is atomic with CAS. Never read-modify-write a JSON column.

## Security checklist for DiskWorkingTree changes

Any change to path resolution must keep these tests passing:

- `escape-prevention.test.ts: parent-directory traversal` — `..` segments
- `escape-prevention.test.ts: absolute-path injection` — paths like `/etc/passwd` resolve INSIDE root
- `escape-prevention.test.ts: symlink escape` — never follow symlinks, reject escaping symlink targets
- `escape-prevention.test.ts: null bytes and weird inputs`
- `escape-prevention.test.ts: cp / mv cannot bridge in or out`

If you're modifying `resolve()` or `resolveAllowLeafSymlink()`, re-read these tests carefully.

## Common commands

```bash
vp run just-stash#test
vp run just-stash#build
vp check
```

## Testing

- `MemoryBackend` is the default test backend; `cloneHandle()` shares state for concurrency tests
- `SqliteStore` tests gracefully skip without `better-sqlite3` native bindings
- Disk-based tests use `mkdtempSync` and clean up in `afterEach`
- **Integration tests** live in `*.integration.test.ts` files and run as part of the normal test suite. They use `testcontainers` to spin up real Postgres (`postgres.integration.test.ts`), MinIO (`s3.integration.test.ts`), and Gitea (`gitea.integration.test.ts`). When adding a new store or backend that talks to external services, add a matching integration test rather than only a unit test against a fake — the fake's behavior can drift from reality.
- Run with `vp run just-stash#test` for the full package suite or `vp run just-stash#test:integration` for the integration subset (requires Docker).
