# Architecture

## Goal

Run many ephemeral agent sandboxes per machine, persist their filesystems durably off-box, resurrect them anywhere, fork them cheaply, restore them quickly when warm.

That's the whole job.

## Non-goals

- **Persisting host directories.** just-stash owns its working trees. Don't point it at directories you care about.
- **Background sync.** If `commit()` hasn't returned, the data isn't durable. There is no "we'll push it later" mode.
- **Branching within a sandbox.** One backend per sandbox. Branching across sandboxes = forking to a new backend.
- **Subprocess sandboxing.** just-bash has no subprocesses — its commands are in-process JavaScript. There's nothing for us to confine at the OS layer.
- **Cross-machine concurrent ownership.** The harness pins each sandbox to one machine; just-stash guards against accidental races via CAS but doesn't try to solve distributed locking.

## The deployment shape we're built for

```
┌──────────────────────────────────────────────────────────┐
│ Harness machine                                          │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Harness process                                    │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │ WorkspaceManager (one per machine)           │  │  │
│  │  │   - active sandboxes: Map<id, handle>        │  │  │
│  │  │   - TTL eviction, disk budget, lock files    │  │  │
│  │  └────────┬─────────┬────────┬────────┬─────────┘  │  │
│  │           │         │        │        │            │  │
│  │     ┌─────▼──┐ ┌────▼───┐ ┌──▼─────┐ ┌▼──────┐     │  │
│  │     │ Sandbox│ │Sandbox │ │Sandbox │ │ ...   │     │  │
│  │     │ alice  │ │  bob   │ │charlie │ │       │     │  │
│  │     └────────┘ └────────┘ └────────┘ └───────┘     │  │
│  │     each = PersistentFs<DiskWorkingTree>           │  │
│  └────────────────────────┬───────────────────────────┘  │
│                           │                              │
│  ┌────────────────────────▼───────────────────────────┐  │
│  │ /var/lib/just-stash/                                 │  │
│  │   trees/<id>/    ← agent's view of /               │  │
│  │   caches/<id>/   ← per-sandbox backend cache       │  │
│  │   locks/<id>     ← single-writer locks             │  │
│  │   meta/<id>.json ← lastBootedHead, treeClean, lastActiveAt │  │
│  └────────────────────────┬───────────────────────────┘  │
└───────────────────────────┼──────────────────────────────┘
                            │
              durable backends (off-machine)
                            │
        ┌──────────────────┴──────────────────┐
        ▼                                       ▼
  git remote                              blob stores + metadata
  (Cloudflare Artifacts,                   (S3BlobStore, AzureBlobStore +
   GitHub, self-hosted)                     S3MetadataStore, Postgres,
                                            SQLite, or another store)
```

The S3-only path uses S3 conditional writes (`If-Match` etags) for atomic CAS on the HEAD pointer. This means production deployments can be backed by literally one S3-compatible bucket — no Postgres, no extra services. Works on AWS S3 (post-2024), Cloudflare R2, Tigris, MinIO.

Azure Blob is a blob-store implementation only. It plugs into `BlobBackend` for archive bytes and should be paired with a `MetadataStore` such as Postgres or SQLite.

The trees and caches under `/var/lib/just-stash/` are caches — losing them is recoverable from the backend, just slower. The backends are durable.

## The four layers

```
Agent (just-bash, AI harness)
        │ IFileSystem
        ▼
Wrappers — composable, all implement IFileSystem
   SizeLimitedFs    (cap bytes / entries)
   PersistentFs     (boot / commit / rollback / fork)
        │
        ▼
SnapshotBackend — the central abstraction
   GitBackend       (isomorphic-git, optional remote)
   BlobBackend      (tar.zst + BlobStore + MetadataStore)
        │
        ▼
Stores — pluggable halves of BlobBackend
   InMemory  |  Sqlite (both)  |  S3-only  |  S3/Postgres  |  Azure/Postgres
```

The disk-backed working tree (DiskWorkingTree) and the pool manager (WorkspaceManager) sit above the wrappers — they're how the harness creates and manages `PersistentFs` instances at scale.

## DiskWorkingTree: the security layer

The IFileSystem boundary is the entire security model. just-bash has no subprocesses; everything that touches the filesystem goes through IFileSystem. So if IFileSystem rejects paths that try to escape, nothing can escape.

DiskWorkingTree enforces three rules on every operation:

1. **Path normalization rejects `..` segments outright.** Not collapsed, rejected. An agent that writes `/foo/../bar` gets ENOENT, not a read of `/bar`.
2. **Path resolution walks segments one at a time, calling `lstat`, refusing to traverse any symlink.** Pre-existing symlinks in the tree (which shouldn't normally appear, but might from a malformed snapshot or a buggy commit walk) become invisible — reads through them return ENOENT.
3. **Symlink creation is allowed but the target is depth-checked.** Absolute targets are rejected. Relative targets that ascend above the sandbox root are rejected. Safe relative targets are written to disk as real symlinks but, per rule 2, can't be read through.

The tests in `escape-prevention.test.ts` enumerate the attacks we defend against: `..` paths, absolute path injection, pre-existing symlinks pointing outside, symlinks created with escaping targets, null bytes, Windows-style separators, and the combination of `cp`/`mv` between sandboxed and escaping paths.

What we don't defend against: out-of-band access. If the harness opens files via raw `fs.readFile` outside the IFileSystem, just-stash can't help. The harness is responsible for not doing that.

## WorkspaceManager: the pool

Multiple sandboxes per machine, lifecycle-managed.

`acquire(sandboxId)`:

1. Validate the sandbox ID (alphanumeric + `-._`, no leading dot, no path separators, max 128 chars).
2. Check the in-process active map. Throw `SandboxLockedError` if already held.
3. Sweep idle sandboxes (TTL + disk budget) unless disabled.
4. Build the backend via the configured factory; initialize it.
5. Open or create the tree directory; restore from backend HEAD UNLESS the persisted metadata says the cached tree is clean and `lastBootedHead` matches (warm-boot fast path).
6. Update activity timestamp; return a handle.

`release()`:

1. Persist `lastBootedHead`, `treeClean`, and `lastActiveAt` to `meta/<id>.json`.
2. Drop the in-process lock.

`sweep()` (called on every acquire by default):

1. TTL: any sandbox idle longer than `ttlMs`, with no active handle, gets its tree directory deleted.
2. Disk budget: if total tree size still exceeds `maxDiskBytes`, evict oldest-idle first until under.

### Warm-boot optimization

`PersistentFs.boot()` is O(workspace size) — it clears the tree and rewrites every file. The manager skips this entirely when the existing tree matches the backend HEAD:

```typescript
if (meta.treeClean && backendHead === meta.lastBootedHead) {
  // Warm boot: tree already correct. Skip restore.
} else {
  await fs.boot();
  meta.lastBootedHead = fs.getKnownHead();
  meta.treeClean = true;
}

// Before handing out the handle, persist treeClean=false. A crash
// before release must not let the next process trust the cached tree.
// Clean release flips it back to true if no uncommitted mutations remain.
```

This is the single biggest UX win from disk-backed working trees. A coding agent re-acquiring the same sandbox between turns sees near-zero startup cost.

### Single-writer enforcement

`WorkspaceManager` enforces single-writer-per-sandbox at two independent layers. Each protects against a different failure mode; they're not redundant.

**In-process** — a synchronously-modified `pending: Set<string>` plus the existing `active: Map`. Checked at the top of `acquire()` before any `await`. Closes the race window where two concurrent `acquire('alice')` calls in the same Node process could both pass the initial check (the `active.set` happens after multiple awaits — every yield point is an opportunity for another async context to enter).

This protection is essentially free (Map + Set lookups) and is always on. It is NOT optional; the cost of accidentally allowing two handles to the same sandbox is data corruption.

**Cross-process** — a real lockfile under `<root>/locks/<id>.lock`. **Opt-in via `crossProcessLocking: true`**; off by default because the common deployment (one Node process owning the root) doesn't need it and shouldn't pay for it. When enabled, the locking protocol is in pure Node with no native dependencies:

1. **Acquire** via `open(lockPath, 'wx')` — an atomic create-or-fail. The first writer wins; the rest get `EEXIST`.
2. **Lockfile body** records the owning process's PID and a per-acquire nonce: `<pid>\n<nonce>\n<acquired-at>\n`.
3. **Heartbeat** — a 30-second `setInterval` calls `utimes` on the lockfile to refresh its mtime. The interval is `unref`'d so it doesn't keep the process running.
4. **Reclaim** — when an acquirer hits `EEXIST`, it checks the lockfile's mtime. If older than 90 seconds AND the recorded PID is dead (`process.kill(pid, 0)` throws `ESRCH`), the lockfile is deleted and the create is retried. Otherwise, `SandboxLockedError`.
5. **Release** — clear the heartbeat, then verify the lockfile still contains our nonce before deleting. If the nonce doesn't match, someone else legitimately reclaimed our (stale) lock; we just clean up without unlinking.

When disabled (the default), `acquireFileLock` returns a sentinel handle that performs no filesystem operations. The in-process layer still protects against same-process races; only the file-based machinery is skipped.

**When to enable.** Whenever a second Node process can ever touch the same root. Examples: a deploy that briefly runs old and new harness side-by-side, a sidecar that also calls `WorkspaceManager`, a misconfigured restart that doesn't fully terminate. The cost is microseconds; the safety against silent corruption is significant.

**When to leave disabled.** Single-process deployments where you genuinely control how many processes touch the root. The harness as a long-running single Node process is the canonical case.

Crash safety (with cross-process locking on): if the owner dies, the heartbeat stops. The next `acquire` notices the stale mtime, verifies the PID is dead, and reclaims. Pathological case (PID dead but mtime fresh — shouldn't happen but defensive): `SandboxLockedError`. Pathological case (PID alive but mtime stale — stuck process holding a lock without heartbeat): we refuse to steal, safer to wait.

**Limitations.** NFS doesn't reliably implement atomic `O_CREAT|O_EXCL`; don't put the lockfile root on NFS when this is enabled. PID reuse across a long timespan could theoretically confuse the liveness check, but the mtime TTL handles this — old locks always become reclaimable. PID liveness on Windows is supported via `process.kill(pid, 0)`.

### Observability

`WorkspaceManager` extends `EventEmitter` with typed events:

| Event     | Args                                                                                 | When                                                                            |
| --------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `acquire` | `(sandboxId, { warmBoot, restoreSkipped, durationMs, backendHead, lockDurationMs })` | Handle handed out. `warmBoot`/`restoreSkipped` are true if restore was skipped. |
| `restore` | `(sandboxId, { durationMs, head })`                                                  | Tree restored from backend during acquire. Not emitted on warm boot.            |
| `release` | `(sandboxId)`                                                                        | Handle released or disposed.                                                    |
| `evict`   | `(sandboxId, { reason })`                                                            | Tree directory deleted. `reason` is `'ttl' \| 'budget' \| 'explicit'`.          |
| `sweep`   | `({ scanned, evicted })`                                                             | After a sweep completes.                                                        |

These are fire-and-forget; just-stash doesn't await listeners. Use them to plug into your metrics or logging stack without adding dependencies on a specific framework.

Example:

```typescript
manager.on("acquire", (_sandboxId, info) => {
  metrics.timing("just_stash.acquire_ms", info.durationMs, {
    warm: info.warmBoot ? "true" : "false",
  });
});
manager.on("restore", (_sandboxId, info) => {
  metrics.timing("just_stash.restore_ms", info.durationMs);
});
```

## SnapshotBackend contract

```typescript
interface SnapshotBackend {
  readHead(): Promise<SnapshotId | null>;
  restore(snapshotId, into): Promise<void>;
  commit({ fs, excludePaths, priorHead, metadata }): Promise<CommitInfo>;
  rollback(target, priorHead): Promise<void>;
  getCommit(snapshotId): Promise<CommitInfo | null>;
  log({ limit?, since? }): Promise<CommitInfo[]>;
  diff(from, to?): Promise<DiffEntry[]>;
  addNote(snapshotId, note): Promise<void>;
  getNote(snapshotId): Promise<string | null>;
  fork?(dst): Promise<void>;  // optional native fork
  close(): Promise<void>;
}
```

Five invariants:

1. **CAS on commit and rollback.** Throw `CasConflictError` on prior-head mismatch.
2. **Durability on return.** Commit success means crash-safe.
3. **Snapshot ids identify commits.** Content-addressed backends keep dedup keys separate from commit ids.
4. **Restore reproduces tree exactly.** Walk order and mode bits may differ; the tree must not.
5. **`getCommit` is cheap.** Doctor and operational tools walk chains one parent at a time.

## Memory and disk costs

For a 50MB workspace with 200 files using `WorkspaceManager + DiskWorkingTree + GitBackend`:

| Stage                                | Process memory            | Tree disk           | Cache disk            |
| ------------------------------------ | ------------------------- | ------------------- | --------------------- |
| Cold boot (first acquire)            | ~few MB                   | ~50MB after restore | ~15MB packfile        |
| Steady-state agent work              | ~few MB                   | ~50MB               | ~15MB                 |
| `commit` (one file changed)          | +transient (largest file) | unchanged           | +few KB loose objects |
| Warm boot (re-acquire after release) | ~few MB                   | unchanged (skipped) | unchanged             |

Process memory is bounded by the wrappers' bookkeeping plus transient buffers during reads/writes. It does NOT scale with workspace size, because the working tree is on disk.

Tree disk scales with workspace size. The `maxDiskBytes` budget across all sandboxes caps this.

Cache disk scales with the git object database (or tar archive count). Periodic `git gc` on the cache, or full eviction via `WorkspaceManager.evict`, manages this.

## How CAS works across stores

Every `MetadataStore` implementation enforces the same contract: atomic compare-and-swap on HEAD. The mechanism varies by what the underlying system supports.

| Store                   | Primitive               | Pattern                                                                                                                 |
| ----------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `S3MetadataStore`       | conditional writes      | Read HEAD with its etag → check priorHead matches → write commit object → `PUT HEAD` with `If-Match: <etag>`            |
| `PostgresMetadataStore` | row locks (pessimistic) | `BEGIN` → `SELECT FOR UPDATE` this namespace's HEAD → check priorHead → INSERT commit + UPDATE HEAD → `COMMIT`          |
| `SqliteStore`           | write transaction       | `BEGIN` (deferred) → SELECT HEAD → check priorHead → INSERT commit + UPDATE HEAD → `COMMIT` (whole DB is single-writer) |
| `InMemoryMetadataStore` | event-loop atomicity    | JS is single-threaded; the check + swap runs without yielding                                                           |

The S3 path is optimistic — work happens _before_ the CAS, so a true race window exists where the commit object is written but the HEAD swap fails. The doctor's `findOrphanCommits` cleans up the rare orphan that results.

The Postgres and SQLite paths are pessimistic — the lock prevents any other writer for that timeline from observing the in-flight state, so there is no race window and no orphan source from this path. Orphans still happen from rollbacks and external mutations, which is why `findOrphanCommits` works against all stores.

### Postgres namespacing

`MetadataStore` is intentionally single-timeline: methods like `readHead()` don't take a sandbox id. `PostgresMetadataStore` preserves that abstraction by scoping the store instance:

```typescript
new PostgresMetadataStore({ pool, namespace: sandboxId });
```

With the default prefix, the physical tables are shared across sandboxes:

- `just_stash_heads(namespace primary key, snapshot_id)`
- `just_stash_commits(namespace, snapshot_id, content_id, parent_id, ..., primary key(namespace, snapshot_id))`
- `just_stash_notes(namespace, snapshot_id, note, primary key(namespace, snapshot_id))`

CAS locks only the row in `just_stash_heads` for the store's namespace. Commits, notes, log traversal, `listCommitIds`, and `deleteCommit` are all namespace-scoped, so two sandboxes can use the same table set without interfering.

### Why we kept Postgres pessimistic

The S3 model could be ported to Postgres via optimistic UPDATE:

```sql
UPDATE heads SET snapshot_id = $new
 WHERE namespace = $namespace
   AND snapshot_id IS NOT DISTINCT FROM $prior
```

If `rowcount === 0`, CAS failed. No row lock held during the work. Better behavior under pgbouncer's transaction-pooling mode where long-held locks cause grief.

We left the pessimistic version because:

1. `WorkspaceManager` enforces single-writer-per-sandbox in-process. The conflict case is genuinely rare.
2. The work done while holding the lock (one INSERT + one UPDATE) is sub-millisecond.
3. Pessimistic locking has no orphan-commit window. Optimistic adds one.
4. The current code is tested and correct.

If a deployment hits pgbouncer issues, switching is mechanical. The interface doesn't change.

## What we punted on

- **History pruning.** Git's chain can't drop old commits without rewriting refs (breaks forks). We rely on content-dedup keeping disk costs bounded.
- **End-to-end test against the actual harness.** All tests are just-stash's own. The first integration with the harness's `Bash`, Pi command surface, and lifecycle will reveal whatever it reveals.

## Recently addressed

These were on the "what we punted on" list in earlier versions, now resolved:

- ~~**Cloudflare Artifacts native fork.**~~ `@jthieman/just-stash/cloudflare` exposes the full Artifacts REST API including server-side fork. `GitBackend` handles the data plane unchanged.
- ~~**Integration tests against real backends.**~~ Added `*.integration.test.ts` files for Postgres (real Postgres), S3 (MinIO), Azure Blob (Azurite), and git remote (Gitea), all via `testcontainers`. They run as part of the normal test suite and require Docker.
- ~~**Cross-process locks.**~~ Implemented in pure Node via the `open('wx')` + PID + mtime heartbeat pattern. See "Single-writer enforcement" above.
- ~~**Observability hooks.**~~ `WorkspaceManager` is now an `EventEmitter` with typed events.
- ~~**Ambiguous-commit recovery.**~~ `PersistentFs.reconcile(error)` returns a structured outcome so callers can distinguish CAS conflicts from "we don't know if it landed."
- ~~**Deterministic snapshot bytes across filesystems.**~~ `walkSnapshot` now sorts entries lexically before iterating.
- ~~**Bounded memory for chain walks.**~~ `doctor` walks via `getCommit` + `parentId` instead of loading full histories.
