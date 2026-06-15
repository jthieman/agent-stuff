# just-stash

Restorable, forkable persistence for [just-bash](https://github.com/just-bash/just-bash) filesystems.

just-stash is the persistence layer for a sandbox-pool harness. You wrap a working filesystem, point it at a backend (git remote, S3+Postgres, SQLite), and you get `boot()`, `commit()`, `rollback()`, and `fork()` against durable storage. Sandboxes die, you resurrect them from any other process by pointing at the same backend.

It's designed for ephemeral compute running many sandboxes per host — agent harnesses, CI workers, sandboxed dev environments. The local disk is a cache; the source of truth lives in the backend.

## Where to look

- **This README** — API reference and feature overview
- **[docs/integration.md](./docs/integration.md)** — how to actually use just-stash in your app: lifecycle patterns, what to store in your DB, common pitfalls, when to write a custom backend
- **[docs/architecture.md](./docs/architecture.md)** — internals: layers, CAS mechanisms, locking protocol

## Status

Early. API may change.

## Install

Requires Node.js 22.15.0 or newer. Blob-backed stores use Node's built-in zstd APIs.

```bash
pnpm add just-stash just-bash
```

Optional peer dependencies, one per backend you use:

```bash
pnpm add isomorphic-git      # GitBackend
pnpm add better-sqlite3      # SqliteStore
pnpm add @aws-sdk/client-s3  # S3BlobStore
pnpm add pg                  # PostgresMetadataStore
```

## The recommended shape: WorkspaceManager + DiskWorkingTree

For real workloads — multiple sandboxes per machine, real disk usage, warm boots — use the manager:

```typescript
import { Bash } from "just-bash";
import { WorkspaceManager } from "just-stash";
import { GitBackend } from "just-stash/git";
import http from "isomorphic-git/http/node";

const manager = new WorkspaceManager({
  root: "/var/lib/just-stash",
  defaults: {
    backendFactory: (sandboxId) =>
      new GitBackend({
        remote: {
          url: `https://artifacts.example.com/${sandboxId}.git`,
          token: process.env.GIT_TOKEN,
          http,
        },
        cacheDir: `/var/lib/just-stash/caches/${sandboxId}.git`,
      }),
    initializeBackend: (b) => (b as GitBackend).initialize(),
    excludeFromSnapshots: ["/scratch"],
  },
  ttlMs: 30 * 60_000, // evict trees idle > 30min
  maxDiskBytes: 50_000_000_000, // total disk budget for tree caches
  // crossProcessLocking: true,        // ← uncomment if >1 Node process shares this root
});

// Each sandbox session:
const handle = await manager.acquire("alice");
try {
  const bash = new Bash({ fs: handle.fs });
  await bash.exec("cat README.md");
  await handle.fs.writeFile("/notes.md", "# session 1");
  await handle.fs.commit({ trigger: "turn_end" });
} finally {
  await handle.release();
}
```

`acquire()` returns a handle holding a single-writer lock on that sandbox. `release()` drops the lock and updates the activity timestamp. Idle sandboxes are evicted on the next acquire (or via `manager.sweep()`). Warm boots are O(1) — if the cached tree is clean and already at the backend's HEAD, no restore happens.

### Cross-process locking

By default, `WorkspaceManager` assumes a **single Node process** owns the workspace root. This is the common case (one harness, one machine), and skipping the lockfile machinery gives you a few extra microseconds per acquire/release plus no background timers.

**In-process safety is always on.** Two concurrent `acquire('alice')` calls within one Node process will throw `SandboxLockedError` from the second, regardless of any setting. The protection comes from a synchronously-modified `pending` set that closes the await-yield race between the initial check and the final `active.set`.

**If more than one Node process can acquire sandboxes from the same root, you MUST opt into cross-process locking:**

```typescript
const manager = new WorkspaceManager({
  root: '/var/lib/just-stash',
  defaults: { ... },
  crossProcessLocking: true,  // REQUIRED for multi-process safety
});
```

Multi-process scenarios include: running a second copy of the harness against the same root; restart-with-overlap during a deploy (old process and new process briefly coexist); sidecar tooling that also calls `WorkspaceManager`; container restarts that don't fully terminate the previous container.

**Without this flag, two processes acquiring the same sandbox will silently corrupt each other's working tree.** The corruption looks like filesystem races: files appearing/disappearing, commits with garbled content, restore producing inconsistent state. It is not easy to debug after the fact.

When `crossProcessLocking: true`, just-stash uses a lockfile under `<root>/locks/<id>.lock` with atomic `open('wx')`, a PID + nonce body, a 30-second mtime heartbeat, and a 90-second TTL with PID-liveness check for stale-lock reclaim. No native dependencies. Works on any filesystem with atomic `O_CREAT|O_EXCL` semantics — **NFS is NOT safe** for the lock root.

### Observability

`WorkspaceManager` extends `EventEmitter` with typed events. Use them for metrics, structured logging, or any custom integration:

```typescript
manager.on("acquire", (sandboxId, { warmBoot }) => {
  metrics.counter("sandbox.acquire", { warm: warmBoot ? "y" : "n" });
});
manager.on("release", (sandboxId) => {
  /* ... */
});
manager.on("evict", (sandboxId, { reason }) => {
  // reason: 'ttl' | 'budget' | 'explicit'
});
manager.on("sweep", ({ scanned, evicted }) => {
  /* ... */
});
```

## What the agent sees

A normal Linux-like filesystem rooted at `/`. just-bash's built-in commands (grep, sed, awk, jq, etc.) read and write through the IFileSystem. No subprocesses, no host escape — just-bash is a sandboxed interpreter.

just-stash adds three properties on top of that:

1. **The agent only sees files within its sandbox.** `DiskWorkingTree` rejects `..` traversal, absolute paths that escape, symlinks pointing outside, and any operation that would touch the host filesystem.
2. **State is restorable.** When the container dies, the next process can point at the same backend and resurrect the sandbox.
3. **State is forkable.** Cheap O(1) divergence — new sandbox starts at another sandbox's current state, then evolves independently.

## Wrappers

All implement `IFileSystem`. Composable freely.

### `DiskWorkingTree`

The recommended production inner. Backs an `IFileSystem` with a real on-disk directory and enforces sandbox isolation.

```typescript
new DiskWorkingTree({ root: "/var/lib/just-stash/trees/alice" });
```

The root must exist (`WorkspaceManager` creates it for you). Every operation is path-checked against this root: `..` is rejected, absolute paths in arguments are interpreted as virtual paths under root (so `/etc/passwd` means `<root>/etc/passwd`, not `/etc/passwd` on the host), and symlinks are never followed during traversal.

Symlink creation is allowed but only with relative targets that lexically stay inside the sandbox. Pre-existing symlinks at the leaf are not followed for reads.

### `SizeLimitedFs`

```typescript
new SizeLimitedFs(inner, {
  maxBytes: 1_000_000_000,
  maxEntries: 100_000,
});
```

Throws `ENOSPC` when a write would exceed either limit. Byte accounting is maintained incrementally for operations through the wrapper and can be recalculated after restores; treat the byte cap as a practical guardrail rather than an auditor for out-of-band filesystem mutations.

Agent-visible path filtering is outside just-stash's persistence model. Use `just-bash-filtered-fs` when an agent should see only part of an `IFileSystem`.

### `PersistentFs`

```typescript
new PersistentFs(inner, {
  backend,
  excludeFromSnapshots: ["/scratch"],
  author: { name: "agent", email: "agent@example.com" },
});
```

Lifecycle:

```typescript
await fs.boot(); // restore from HEAD
await fs.commit({ trigger: "turn_end", note: "metadata" });
await fs.rollback(snapshotId);
const history = await fs.log({ limit: 20 });
const changes = await fs.diff(fromId, toId);
```

`log()` returns newest-first. Omit `limit` to return the full reachable chain, or pass `limit` for bounded UI timelines.

`commit()` blocks until the snapshot is durably persisted to the backend. There's no separate "push" — if commit returns, the data survives a container crash.

## Backends

### `GitBackend`

```typescript
import { GitBackend } from "just-stash/git";
import http from "isomorphic-git/http/node";

const backend = new GitBackend({
  remote: { url, token, http },
  cacheDir: "/tmp/cache", // optional; managed temp dir if omitted
});
await backend.initialize();
```

Snapshots are real git commits in a bare cache repo. The agent's sandbox tree is plain files with no `.git`; harness code can inspect `cacheDir` out of band with normal git tooling. Notes (`addNote`/`getNote`) live under `refs/notes/just-stash` and are pushed/fetched with remote-backed GitBackend instances. Native fork copies objects between local repos.

For remote-backed repos, `rollback()` moves the branch backward with force-with-lease semantics: it force-pushes only when the remote still points at the caller's `priorHead`. If another writer advanced the remote first, rollback restores the local ref and throws `CasConflictError`.

### `BlobBackend`

```typescript
import { BlobBackend } from "just-stash";
import { S3BlobStore, S3MetadataStore } from "just-stash/s3";
import { PostgresMetadataStore } from "just-stash/postgres";

// S3-only (recommended for new deployments) — no other infrastructure
const blobs = new S3BlobStore({ bucket: "my-bucket" });
const metadata = new S3MetadataStore({ bucket: "my-bucket" });
await metadata.initialize();
const backend = new BlobBackend({ blobs, metadata });

// S3 + Postgres (if you already run Postgres and want SQL-queryable history)
const backend = new BlobBackend({
  blobs: new S3BlobStore({ bucket: "my-bucket" }),
  metadata: new PostgresMetadataStore({ pool }),
});
```

Snapshots are tar.zst archives keyed by SHA-256, with a separate commit id for each history entry. Identical content dedups across forks and no-op commits, while every successful commit still advances the chain. Mix-and-match stores:

| BlobStore           | MetadataStore                 | When to use                       |
| ------------------- | ----------------------------- | --------------------------------- |
| `InMemoryBlobStore` | `InMemoryMetadataStore`       | tests                             |
| `SqliteStore`       | `SqliteStore` (same instance) | local dev, embedded               |
| `S3BlobStore`       | `S3MetadataStore`             | **production, S3-only**           |
| `S3BlobStore`       | `PostgresMetadataStore`       | production with existing Postgres |

The S3-only path uses S3 conditional writes (`If-Match` etags, `If-None-Match: "*"`) for atomic CAS — works on AWS S3 (post-2024), Cloudflare R2, Tigris, MinIO, anything S3-compatible with conditional write support.

### `MemoryBackend`

Tests and trivial demos. Use `.cloneHandle()` for concurrent commit simulation.

## CAS and concurrent commits

```typescript
try {
  await fs.commit({ trigger: 'turn_end' });
} catch (e) {
  if (e instanceof CasConflictError) {
    await fs.boot();          // re-sync from backend
    await fs.commit({ ... }); // retry
  } else throw e;
}
```

The `WorkspaceManager` enforces single-writer-per-sandbox both in-process and across processes (via the lockfile), so CAS conflicts in practice only happen if you deliberately bypass it (e.g., direct backend access from a sidecar).

When reusing a remote-backed `GitBackend` directly, `fs.boot()` reads the current remote HEAD before restoring, so a long-lived local bare cache observes commits pushed by other writers before rebuilding the working tree.

### Handling ambiguous failures

A network error during `commit()` is ambiguous — the backend may have accepted the commit before the response was lost. `PersistentFs.reconcile(error)` returns a structured outcome to help you decide:

```typescript
const priorHead = await backend.readHead(); // capture before commit
try {
  await fs.commit({ trigger: "turn_end" });
} catch (e) {
  const outcome = await fs.reconcile(e);

  if (outcome.kind === "conflict") {
    // CAS conflict — definitely failed; someone else won
    // outcome.actualHead is what they committed
    await fs.boot();
    // ... retry
  } else if (outcome.kind === "observed") {
    if (outcome.currentHead === priorHead) {
      // HEAD didn't move — your commit definitely didn't land
      // ... safe to retry
    } else {
      // HEAD moved — your commit MAY have landed, or someone else
      // committed. Walk fs.log() and check whether the new HEAD's
      // tree matches what you intended.
    }
  }
}
```

This isn't a magic "did my commit succeed" oracle — the backend has no way to tell you that directly after a network failure. `reconcile` just gives you the observable state and lets you decide.

## Pi integration

```typescript
import { registerSnapshotCommands } from "just-stash/pi";
registerSnapshotCommands(piRegistry, handle.fs);
```

Adds `/snapshot [note]`, `/snapshots`, `/rollback <id-prefix>`.

## Cloudflare Artifacts

[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) is a Git-compatible artifact store designed for agent workloads. The data plane is standard smart-HTTPS Git, so `GitBackend` talks to it without modification. `just-stash/cloudflare` handles the management plane: creating repos on demand, server-side fork (no data transfer), minting per-session tokens.

```typescript
import { CloudflareArtifacts } from "just-stash/cloudflare";

const cf = new CloudflareArtifacts({
  apiToken: process.env.CF_API_TOKEN!,
  namespace: "my-agents",
});

// Per-session: ensure repo exists, mint a fresh token, return a GitBackend
const { backend, repo, token, expiresAt } = await cf.createBackend("alice", {
  cacheDir: "/var/lib/just-stash/caches/alice.git",
});

// Server-side fork (one HTTP call; no chain push)
const forked = await cf.forkRepo("alice", {
  name: "alice-experiment",
  default_branch_only: true,
});

// Import an existing public repo as a starting point
await cf.importRepo("react-mirror", {
  url: "https://github.com/facebook/react",
  branch: "main",
  depth: 100,
});

// Cleanup
await cf.deleteRepo("alice-experiment");
```

Slots into `WorkspaceManager` via `backendFactory`:

```typescript
const manager = new WorkspaceManager({
  root: "/var/lib/just-stash",
  defaults: {
    backendFactory: async (sandboxId) =>
      (
        await cf.createBackend(sandboxId, {
          cacheDir: `/var/lib/just-stash/caches/${sandboxId}.git`,
        })
      ).backend,
  },
});
```

The full REST surface (`createRepo`, `getRepo`, `listRepos`, `deleteRepo`, `forkRepo`, `importRepo`, `createToken`, `listTokens`, `revokeToken`) mirrors [Cloudflare's API](https://developers.cloudflare.com/artifacts/api/rest-api/). Errors come back as `CloudflareArtifactsError` with the HTTP status and the API's error envelope preserved.

## Operations: doctor / GC

For long-running deployments, just-stash/doctor offers tools to inspect and clean up state:

```typescript
import {
  verifyIntegrity,
  findOrphanBlobs,
  pruneOrphanBlobs,
  findOrphanCommits,
  pruneOrphanCommits,
  findStaleWorkspaces,
  pruneOrphanedMeta,
} from "just-stash/doctor";

// Backend integrity: walk the commit chain, check parent linkage and content blob presence
const report = await verifyIntegrity(backend, { blobs });
if (report.missingBlobs.length > 0) {
  console.warn("Backend damaged:", report.missingBlobs);
}

// Orphan blobs (for BlobBackend): data in storage not reachable from HEAD
const orphans = await findOrphanBlobs(metadata, blobs);
await pruneOrphanBlobs(blobs, orphans.orphanKeys, { apply: true });

// Orphan commits (any MetadataStore): commit rows not reachable from HEAD.
// Survivors of rollbacks, external mutations, or race-time anomalies.
const cReport = await findOrphanCommits(metadata);
await pruneOrphanCommits(metadata, cReport.orphanIds, { apply: true });

// Stale workspace trees (for WorkspaceManager): trees idle > threshold
const stale = await findStaleWorkspaces({
  managerRoot: "/var/lib/just-stash",
  staleAfterMs: 24 * 60 * 60_000,
});
for (const s of stale.staleSandboxes) {
  await manager.evict(s.sandboxId);
}

// Orphaned meta files (workspace tree was removed but meta file wasn't)
await pruneOrphanedMeta({ managerRoot: "/var/lib/just-stash", apply: true });
```

All read-only by default — pass `apply: true` to actually delete.

## What we don't do

- **Subprocess sandboxing.** just-bash has no subprocesses — its commands are all in-process JavaScript. Subprocess isolation isn't an just-stash concern.
- **Host filesystem persistence.** Don't wrap a directory you want preserved. just-stash assumes ownership of the working tree it manages and may clear it on boot.
- **Background sync.** If commit hasn't returned, the data isn't durable.
- **Cross-machine concurrent ownership.** Within one machine, `WorkspaceManager`'s lockfile guards against concurrent acquires. Across machines, the harness must ensure a sandbox runs on one machine at a time (the backend's CAS protects against accidental data divergence, but tree caches will diverge between racing machines).

## Testing

Tests include both in-memory/fake coverage and integration coverage against real services:

```bash
vp test
```

Integration tests run against real Postgres and real S3 (via MinIO) using [testcontainers](https://node.testcontainers.org/). They prove that the SQL we emit, the S3 commands we send, and the error shapes we expect actually work against real services — things in-memory fakes can't verify.

```bash
# requires Docker
vp test run integration
```

What the integration tests cover that unit tests can't:

- **Postgres**: `SELECT FOR UPDATE` actually serializes concurrent writers; the exact SQL we emit is accepted; cursor-based `listCommitIds` streams large histories; full BlobBackend+Postgres+doctor round-trip
- **S3** (MinIO): `If-Match` / `If-None-Match` semantics work against real S3 protocol; `412 PreconditionFailed` comes back in the shape `S3MetadataStore` expects; pagination works for `ListObjectsV2`; concurrent CAS-via-network actually serializes
- **Git remote** (Gitea): isomorphic-git push/fetch against real HTTP smart-protocol; token auth wiring; server-side ref check rejects diverged pushes (the CAS-at-the-push-layer property); fetch + restore from a fresh cache (the "new machine warm-boot" path); auth failure surfaces; chain integrity over real HTTP

## Known edge cases

- **Case-insensitive filesystems (macOS HFS+, default APFS, Windows NTFS).** `/Foo` and `/foo` collide on disk. If a snapshot contains both, restore on a case-insensitive filesystem will silently merge them. Use case-sensitive filesystems for the working tree root in production.
- **Unicode normalization (macOS).** macOS normalizes filenames to NFD form on write. A snapshot committed on Linux (which preserves bytes) and restored on macOS may produce different filenames than expected. Stick to one platform per deployment, or normalize before snapshotting.
- **NFS for the lockfile root.** NFS doesn't reliably implement atomic `O_CREAT|O_EXCL`. Put `WorkspaceManager.root` on a local filesystem (the backend can still be remote; only the lock and tree directories need local storage).
- **Symlinks aren't snapshotted.** An agent can create symlinks during a session, but they vanish after commit + boot. This is intentional (symlinks could be reinterpreted on restore in ways that escape the sandbox). If you need stable references, write a file with the target path instead.
- **Empty directories with git remotes.** `GitBackend` preserves empty directories in its local object model, but standard git servers and clients do not generally retain empty tree entries through push/fetch round-trips. Put a placeholder file in directories that must survive a remote-backed restore.
- **Very large commit chains.** `doctor` streams chain walks in bounded memory, but `backend.log({ limit: N })` still returns an array. For sandboxes with millions of commits, use `getCommit` + `parentId` directly.
