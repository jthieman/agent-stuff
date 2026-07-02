# Using just-stash in your application

This guide is for developers integrating just-stash into a larger application — typically an agent harness that manages user sessions, runs conversations, and needs to persist the agent's working files between turns.

The [README](../README.md) covers the API surface; this guide covers the **lifecycle, the data model, and the integration patterns**.

## The mental model

just-stash is the **working tree persistence layer** for your agent. Nothing more, nothing less.

- Your app handles users, authentication, conversation history, agent orchestration, billing, all of that. just-stash has no opinions about any of it.
- just-stash handles: "give me a filesystem the agent can read and write, restore it from where it left off, commit new state durably, let me time-travel and fork it."

If you think of it as "git for the agent's scratch directory," you're close. The agent doesn't see git — it sees an `IFileSystem` it can read and write through the harness. The harness sees a `PersistentFs` with `commit`, `rollback`, `log`, `fork`. Your app sees `WorkspaceManager` with `acquire(sandboxId)` and `release()`.

## What your app stores vs. what just-stash stores

This is the most important distinction. Get it wrong and you'll either duplicate state or lose it.

**Your application database stores:**

| Field                               | Example                            | Notes                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandboxId`                         | `conv_abc123`                      | Stable string identifying which just-stash sandbox to acquire. You choose the format; just-stash validates it (alphanumeric + `_-.` characters, no leading dot, ≤128 chars). |
| Foreign keys                        | `user_id`, `conversation_id`       | How your app maps users/conversations to sandboxes. just-stash doesn't know about users.                                                                                     |
| Backend config                      | `cloudflare_repo: my-agents/alice` | Where the durable snapshot lives. May be implicit (sandboxId = repo name) or explicit (per-tenant routing).                                                                  |
| **Optionally**: pinned snapshot IDs | `last_known_good: 'a3f2...'`       | If your app has features like "restore this version," "compare runs," "undo." Just store the SHA strings.                                                                    |
| **Optionally**: HEAD per session    | `current_head: 'b7e1...'`          | Useful for showing "what state is this conversation in?" without acquiring the sandbox just to peek.                                                                         |

**just-stash stores (under `WorkspaceManager.root`):**

- `trees/<sandboxId>/` — the working tree cache (a real directory on disk). Cleared and rebuilt from the backend on cold boot; reused on warm boot.
- `meta/<sandboxId>.json` — small metadata file: last-active timestamp, last-booted HEAD, and whether the cached tree is clean. Used for warm-boot optimization and TTL eviction.
- `locks/<sandboxId>.lock` — only present if `crossProcessLocking: true` (default false).

**Backend storage (S3, Postgres, Git remote, Cloudflare Artifacts):**

- The actual durable snapshots. Git backends use git commit OIDs. Blob backends store content-addressed archives and separate commit metadata, so identical content dedups automatically while each commit still has its own timeline id.
- For S3-only, use a distinct `S3MetadataStore.prefix` per sandbox, e.g. `metadata/${sandboxId}/`. The `S3BlobStore` prefix may be shared when you want content dedup across sandboxes.
- For S3 + Postgres, use one shared Postgres table set and one `PostgresMetadataStore` instance per sandbox with `namespace: sandboxId`. The `BlobBackend` stays single-timeline; Postgres does the physical namespacing internally.

What you should **not** store in your app database:

- Working-tree file contents (that's just-stash's job; storing them again would diverge)
- Restore-able state that's already in commits (compute it on demand from `handle.fs.log()`)
- Lockfiles, heartbeat state, or anything else from `WorkspaceManager.root`

## The standard lifecycle

The recommended pattern: **acquire at the start of an agent session, release at the end.** "Session" can mean anything from one HTTP request to a long-running conversation; pick whatever fits your architecture.

```typescript
async function runAgentTurn(conversationId: string, userMessage: string) {
  const handle = await manager.acquire(conversationId);
  try {
    // The agent reads/writes through handle.fs
    const bash = new Bash({ fs: handle.fs });
    await runAgent(bash, userMessage);
    // Commit at the natural boundary
    await handle.fs.commit({ trigger: "turn_end" });
  } finally {
    await handle.release();
  }
}
```

Three things to internalize:

1. **`acquire` is cheap on warm boot.** If the cached working tree is clean and already at HEAD (the common case for back-to-back turns), restore is skipped. The cost is a Map lookup + a metadata file read. Don't pre-acquire; just acquire when you need it.

2. **`commit` is the durability boundary.** When it returns, the snapshot is durable on the backend. There is no background sync. If you skip the commit, the next acquire will boot from the previous HEAD — anything in-tree but not committed is lost.

3. **`release` updates the activity timestamp.** This drives TTL-based eviction. If you `dispose()` instead, the in-memory state is dropped immediately (useful on graceful shutdown).

### Where to put the commit

Match it to a meaningful boundary in your agent loop. Common choices:

- **After every turn** (`{ trigger: 'turn_end' }`) — what most agents want. Every user-visible state change is a snapshot you can roll back to.
- **After every tool call** — finer-grained but expensive (full tree walk per commit).
- **On explicit user signal** (`/snapshot` slash command via `just-stash/pi`) — for "save point" workflows.
- **At session end only** — cheapest but loses intra-session rollback. Only viable if your agent doesn't need to undo mid-session.

If a turn doesn't change any files (e.g., the agent just chatted), commit anyway — the blob content dedups, and the distinct commit id keeps the chain consistent with your conversation history.

### Where to call `rollback`

When the user wants to undo, when a guardrail fires, when the agent went down a bad path:

```typescript
const handle = await manager.acquire(conversationId);
try {
  await handle.fs.rollback(targetSnapshotId);
  // Tree is now at targetSnapshotId. backend HEAD has advanced to it.
} finally {
  await handle.release();
}
```

Rollback moves HEAD back to the target without deleting commit rows. The previous HEAD's commit row remains in storage; doctor's `findOrphanCommits` will identify it if no one else references it.

### Where to call `fork`

When you want to branch — try an alternative path, give two agents the same starting state, A/B test something. The destination is a separate sandbox with its own backend:

```typescript
import { PersistentFs } from "just-stash";

const original = await manager.acquire("alice");
try {
  const forkedFs = await PersistentFs.fork({
    src: original.fs,
    dst: makeBackendFor("alice-experiment"),
    innerFactory: () => makeInnerFsFor("alice-experiment"),
  });
  // forkedFs starts at original's current HEAD
} finally {
  await original.release();
}
```

For Cloudflare Artifacts, prefer `CloudflareArtifacts.forkRepo()` — that's a single server-side HTTP call instead of pushing the chain to a new remote.

## Patterns

### Pattern 1: one workspace per conversation

The most common pattern. `sandboxId = conversationId`. Each conversation has its own isolated working tree and commit history. Forks (e.g., user clones a conversation) create new sandboxes via `fork()`.

```typescript
// Your app table:
// conversations(id, user_id, sandbox_id, created_at, last_message_at)

const handle = await manager.acquire(conversation.sandbox_id);
```

### Pattern 2: one workspace per user

The user has a single persistent home directory across all their conversations. `sandboxId = userId`. Concurrent conversations from the same user serialize through just-stash's in-process locking (you'll get `SandboxLockedError` if two turns race; either queue them or use Pattern 1).

```typescript
// Your app table:
// users(id, sandbox_id, ...)

const handle = await manager.acquire(user.sandbox_id);
```

### Pattern 3: branching for alternative agent paths

The agent considers two strategies. Fork the current state, run both, pick the winner. The loser's sandbox can be deleted.

```typescript
const main = await manager.acquire("alice");
const forkA = await PersistentFs.fork({ src: main.fs, dst: forkABackend, innerFactory: makeA });
const forkB = await PersistentFs.fork({ src: main.fs, dst: forkBBackend, innerFactory: makeB });
// run agent against forkA and forkB in parallel; pick the better one
// then either merge back (replay commits onto main) or just use the winner
```

For Cloudflare Artifacts this is cheap (server-side fork). For other backends it costs uploading the chain.

### Pattern 4: pinned snapshots for "named states"

The user wants to mark specific moments: "this is the version that worked," "this is before the refactor." Store the snapshotId in your app DB:

```typescript
// After a successful turn:
const info = await handle.fs.commit({ trigger: "turn_end" });

await db.query(
  "INSERT INTO pinned_states (conversation_id, label, snapshot_id) VALUES ($1, $2, $3)",
  [conversation.id, "before refactor", info.snapshotId],
);
```

Later, to restore that state:

```typescript
const { snapshot_id } = await db.queryOne(
  "SELECT snapshot_id FROM pinned_states WHERE conversation_id = $1 AND label = $2",
  [conversation.id, "before refactor"],
);

const handle = await manager.acquire(conversation.sandbox_id);
await handle.fs.rollback(snapshot_id);
```

The snapshotId is just a string — store it like any other identifier. It's stable and meaningful across machines.

### Pattern 5: showing history

Your UI wants to render a timeline of an agent's progress. Use `PersistentFs.log()` rather than maintaining a parallel history table:

```typescript
const handle = await manager.acquire(conversationId);
try {
  const commits = await handle.fs.log({ limit: 50 });
  return commits.map((c) => ({
    id: c.snapshotId,
    timestamp: c.timestamp,
    trigger: c.trigger,
    message: c.message,
  }));
} finally {
  await handle.release();
}
```

Don't denormalize this into your app DB unless you have specific reasons (e.g., you want to search across sandboxes without acquiring each).

## Persisting commit pointers in your app DB

The pattern is "store the SHA string; treat it as opaque." Three concrete uses:

**Undo with depth:** keep a stack of recent snapshotIds, pop to undo, push on every commit.

```typescript
// after every commit
undoStack.push(info.snapshotId);

// undo
const target = undoStack[undoStack.length - 2]; // not the current head
await fs.rollback(target);
```

**Branch labels:** name specific snapshots for the user to return to.

```sql
CREATE TABLE bookmarks (
  conversation_id TEXT,
  label TEXT,
  snapshot_id TEXT,
  created_at TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, label)
);
```

**Diff-against-reference:** store a "baseline" snapshotId per conversation; show the user what's changed since.

```typescript
const baseline = conversation.baseline_snapshot_id;
const current = await backend.readHead();
if (current && baseline !== current) {
  const changes = await backend.diff(baseline, current);
  // changes: DiffEntry[] — { path, kind: 'added' | 'modified' | 'removed' }
}
```

### What to NOT store in your DB

- The contents of files. They're in the backend; storing them again means two sources of truth that will diverge.
- Full commit histories. Compute via `handle.fs.log()` when needed.
- The working tree state at rest. Acquire when you need it; release otherwise.

## Implementing a custom backend

You can mix-and-match the built-in pieces in three ways before reaching for a custom backend:

1. **Existing backend, different stores.** `BlobBackend` takes any `BlobStore` and `MetadataStore`. Mix S3 blobs with Postgres metadata, or SQLite for both, or InMemory for tests. No new code.
2. **Existing backend, custom config.** `GitBackend` works against any HTTPS smart-protocol Git server. Cloudflare Artifacts, GitHub, GitLab, Gitea, self-hosted — same code.
3. **Wrap an existing backend.** Decorate to add logging, metrics, retries, or caching without changing the contract.

If none of those fit, implement `SnapshotBackend`. The interface is small:

```typescript
interface SnapshotBackend {
  readHead(): Promise<SnapshotId | null>;
  commit(opts: {
    fs: IFileSystem;
    excludePaths: string[];
    priorHead: SnapshotId | null;
    metadata: { trigger: string; message: string; author: Author; timestamp: number };
  }): Promise<CommitInfo>;
  restore(snapshotId: SnapshotId, fs: IFileSystem): Promise<void>;
  rollback(snapshotId: SnapshotId, priorHead: SnapshotId): Promise<void>;
  getCommit(snapshotId: SnapshotId): Promise<CommitInfo | null>;
  log(opts?: { limit?: number; since?: SnapshotId }): Promise<CommitInfo[]>;
  diff(from: SnapshotId, to?: SnapshotId): Promise<DiffEntry[]>;
  close(): Promise<void>;
}
```

Required invariants:

- **`commit` must enforce CAS** via `priorHead`. If the current backend HEAD doesn't match `priorHead`, throw `CasConflictError(priorHead, actualHead)`. This is the single most important guarantee in the system.
- **`snapshotId` identifies a commit history position.** Do not reuse it as a content hash if your backend supports no-op commits. Keep content identity separate, as BlobBackend does with `contentId`.
- **`restore` must produce an exact match** of the snapshot's tree. The fs is cleared first, then populated from the snapshot. Walk via shared `walkSnapshot` helper for consistency.
- **`getCommit` must be cheap.** O(1) lookup. doctor uses it to walk chains.
- **`log` returns newest-first.** Omit `limit` for the full reachable chain, or pass `opts.limit` for bounded UI timelines.

The two built-in backends are your best references:

- **`src/backends/blob.ts`** — the simpler reference. Walks the fs, builds a tar.zst archive, hashes it into a content id, stores via `BlobStore`, then records a distinct commit id via `MetadataStore`. Most custom backends will look like this with different storage choices.
- **`src/backends/git.ts`** — the more complex reference. Uses isomorphic-git to write tree and commit objects directly into a bare repo, optionally pushes to a remote. Useful if you want a custom git server integration or want to share storage with existing git tooling.

Read them in that order. The Blob backend's logic (walk → archive → hash content → store → append commit metadata) is the easier model to extend. The Git backend's logic (build trees recursively, write objects, update refs, push) is closer to git internals.

When to actually reach for a custom backend:

- **New storage system.** GCS with conditional puts, Azure Blob with leases, your-internal-storage-with-CAS — write a `BlobStore` + `MetadataStore` pair, use the existing `BlobBackend`. Almost never write a full backend from scratch.
- **Specialized snapshot semantics.** E.g., per-file blobs instead of one tar archive (better for selective restore); structured-data backends that aren't just bytes.
- **Different durability model.** E.g., a backend that uses synchronous replication across regions before commit returns.

### Using an existing backend as a guide

The codebase is set up so an AI agent can be pointed at `src/backends/blob.ts` and asked to write a parallel implementation for a different storage system. The files are self-contained, the dependencies are minimal (only `walkSnapshot` from the shared helpers), and the SnapshotBackend invariants are stated above. A reasonable prompt:

> Here's the `BlobBackend` implementation. Write a `GCSBackend` that does the same thing but stores blobs and metadata in Google Cloud Storage, using object versioning + If-Generation-Match for atomic CAS on the HEAD pointer.

The agent should produce a single-file backend that imports `walkSnapshot`, `CasConflictError`, etc. from just-stash's exports, and implements the interface. Cross-check by running the doctor module against the result — `verifyIntegrity`, `findOrphanBlobs`, and `findOrphanCommits` should all work without changes.

## Common pitfalls

**Acquire/release imbalance.** If you `acquire` and don't `release`, the lock is held and the in-process slot stays occupied. Always use `try/finally`. If you crash before release, the cross-process lockfile (if enabled) eventually times out via mtime + PID check, but in-process state needs the explicit release.

**Storing tree content in your app DB.** Don't. It diverges from the backend, doubles your storage cost, and means two systems can disagree about "the current state." The backend is the source of truth for working-tree files.

**Calling `commit` after every keystroke or tool call.** Each commit walks the full tree (O(workspace size)) and hashes it. For frequent commits with large trees, this dominates latency. Commit at meaningful boundaries (per-turn is usually right).

**Wrapping a host directory you care about.** `PersistentFs.boot()` clears the inner filesystem before restore. If `DiskWorkingTree` is pointed at `/home/me`, that's wiped. Always point at a directory just-stash owns (under `WorkspaceManager.root` if using the manager).

**Multi-process without enabling cross-process locks.** Default is `crossProcessLocking: false`. Two processes against the same root silently corrupt sandboxes. If you have any chance of multi-process — deploys with overlap, sidecar tooling, container restarts — set it to `true`.

**Forgetting token rotation for git remotes.** If your backend uses a remote git server with short-lived tokens (Cloudflare Artifacts default: 24h), you need to either mint a fresh token per session (via `CloudflareArtifacts.createBackend`, which does this automatically), or have a refresh path. A stale token will cause push failures mid-session.

**Backend lifecycle confusion.** Backends are typically one per sandbox. Don't share a backend between sandboxes. The `backendFactory` in `WorkspaceManagerOptions` constructs one per `acquire`. For adapters, share infrastructure clients rather than stateful store instances: share `pg.Pool` and construct `PostgresMetadataStore({ pool, namespace: sandboxId })`; share `S3Client` and construct per-sandbox metadata stores with distinct prefixes.

**Blob GC against shared blob storage.** `findOrphanBlobs({ metadataStores, blobs })` assumes the supplied metadata stores cover the same reachability domain as the blob store's `list()`. If `blobs` is shared across many sandboxes, pass every sandbox's scoped metadata store. If you can't enumerate those stores, run blob GC only on per-sandbox blob prefixes.

**Assuming commits are atomic across sandboxes.** They aren't — each backend has its own CAS chain. If you need atomic multi-sandbox updates, you need a coordinator above just-stash (your app, with a 2PC pattern or saga). just-stash handles single-sandbox consistency only.

## What to read next

- [README](../README.md) — API reference
- [architecture.md](./architecture.md) — internals: layers, CAS mechanisms, locking protocol
- [src/backends/blob.ts](../src/backends/blob.ts) — reference implementation if you're writing a custom backend
- [src/cloudflare-artifacts.ts](../src/cloudflare-artifacts.ts) — example of a management-plane wrapper around an existing backend
