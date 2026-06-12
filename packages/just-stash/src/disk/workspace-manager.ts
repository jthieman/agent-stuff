import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import { join, sep } from "node:path";
import { EventEmitter } from "node:events";
import { DiskWorkingTree } from "./disk-working-tree.ts";
import { PersistentFs } from "../wrappers/persistent-fs.ts";
import type { SnapshotBackend } from "../backend.ts";

export type EvictReason = "ttl" | "budget" | "explicit";

/**
 * Events emitted by WorkspaceManager.
 *
 *   acquire     (sandboxId, { warmBoot })   sandbox acquired; warmBoot=true if restore was skipped
 *   release     (sandboxId)                 sandbox released or disposed
 *   evict       (sandboxId, { reason })     tree deleted; reason is why
 *   sweep       ({ scanned, evicted })      sweep completed
 *
 * Subscribe with manager.on('acquire', (id, info) => ...) etc.
 */
export interface WorkspaceManagerEvents {
  acquire: (sandboxId: string, info: { warmBoot: boolean }) => void;
  release: (sandboxId: string) => void;
  evict: (sandboxId: string, info: { reason: EvictReason }) => void;
  sweep: (info: { scanned: number; evicted: string[] }) => void;
}

/**
 * Per-sandbox configuration. The factory pattern lets the manager
 * defer backend construction until the sandbox is first acquired —
 * cheap when most sandboxes are idle.
 */
export interface SandboxConfig {
  /**
   * Construct the SnapshotBackend for this sandbox.
   */
  backendFactory: (sandboxId: string) => SnapshotBackend | Promise<SnapshotBackend>;

  /**
   * Initialize the backend after construction. Some backends need an
   * async setup step (e.g. GitBackend.initialize). Optional.
   */
  initializeBackend?: (backend: SnapshotBackend) => Promise<void>;

  /** Forwarded to PersistentFs. */
  excludeFromSnapshots?: string[];
  /** Forwarded to PersistentFs. */
  author?: { name: string; email: string };
}

export interface WorkspaceManagerOptions {
  /**
   * Root directory where the manager keeps per-sandbox state.
   * Created if it doesn't exist.
   *
   * Layout:
   *   <root>/trees/<id>/        ← working tree (DiskWorkingTree root)
   *   <root>/locks/<id>.lock    ← per-sandbox single-writer lockfile
   *   <root>/meta/<id>.json     ← lastBootedHead, treeClean, lastActiveAt
   */
  root: string;

  /**
   * Default config for sandboxes; can be overridden per acquire().
   * If omitted, callers must pass config to every acquire().
   */
  defaults?: SandboxConfig;

  /**
   * Idle TTL in milliseconds. A sandbox idle longer than this is
   * eligible for eviction on the next sweep. Default: 30 minutes.
   * Set to 0 to disable TTL eviction (only disk-budget eviction runs).
   */
  ttlMs?: number;

  /**
   * Maximum total bytes across all tree directories. When exceeded
   * after a sweep, oldest-idle sandboxes are evicted until under
   * budget. Default: unlimited.
   */
  maxDiskBytes?: number;

  /**
   * Sweep is run on every acquire() by default. Pass false to disable;
   * caller must then call manager.sweep() manually.
   */
  sweepOnAcquire?: boolean;

  /**
   * Cross-process lockfile enforcement. Default: false.
   *
   * The default optimizes for the common case: a single Node process
   * managing sandboxes against one root directory. In that case the
   * file-lock machinery (atomic create, mtime heartbeat, TTL reclaim)
   * is pure overhead, so we skip it.
   *
   * **Set this to `true` if more than one Node process can ever
   * acquire sandboxes from the same root.** Multiple processes
   * include: running a second copy of the harness, restart-with-
   * overlap during deploys, sidecar tooling that also calls
   * `WorkspaceManager`. Without cross-process locking, two processes
   * acquiring the same sandbox will silently corrupt each other's
   * working tree.
   *
   * In-process safety is enforced separately and is always on — two
   * concurrent acquire() calls for the same sandbox within one
   * process will still throw SandboxLockedError regardless of this
   * setting.
   *
   * Cost when enabled: one syscall on acquire, one timer per held
   * lock, one unlink on release. Well under 1ms per acquire/release
   * pair, negligible compared to backend commit costs.
   */
  crossProcessLocking?: boolean;
}

/**
 * Handle returned by acquire(). Holds a single-writer lock on the
 * sandbox; release() drops the lock. Forgetting to release leaks
 * disk space and blocks future acquires for that sandbox until the
 * lockfile heartbeat expires and stale-lock reclaim succeeds.
 */
export interface SandboxHandle {
  readonly sandboxId: string;
  readonly fs: PersistentFs<DiskWorkingTree>;
  readonly treePath: string;
  /** Update lastActiveAt and drop the in-process lock. */
  release(): Promise<void>;
  /** Same as release but also close() the PersistentFs and backend. */
  dispose(): Promise<void>;
}

interface SandboxMeta {
  sandboxId: string;
  lastBootedHead: string | null;
  treeClean: boolean;
  lastActiveAt: number;
  createdAt: number;
}

interface ActiveEntry {
  handle: SandboxHandle;
  backend: SnapshotBackend;
  lock: LockHandle;
}

/**
 * Multi-sandbox pool. Designed for a harness that runs many concurrent
 * agent sessions on one machine.
 *
 *   const manager = new WorkspaceManager({
 *     root: '/var/lib/just-stash',
 *     defaults: { backendFactory: (id) => new GitBackend({ ... }) },
 *     ttlMs: 30 * 60_000,
 *     maxDiskBytes: 50_000_000_000,
 *   });
 *
 *   const handle = await manager.acquire('alice');
 *   // ... agent runs ...
 *   await handle.release();
 *
 * Concurrency invariants:
 *   - At most one in-process acquire() per sandboxId at a time. Second
 *     acquire while the first is still held throws SandboxLockedError.
 *   - Cross-process safety via lockfile under <root>/locks/<id>.lock.
 *     Other processes attempting to acquire the same id fail. If a
 *     process dies holding the lock, the heartbeat stops and another
 *     process can reclaim the stale lock after the TTL and PID-liveness
 *     checks pass.
 *   - Eviction never touches sandboxes with active handles.
 */
export class WorkspaceManager extends EventEmitter {
  private readonly root: string;
  private readonly defaults: SandboxConfig | undefined;
  private readonly ttlMs: number;
  private readonly maxDiskBytes: number;
  private readonly sweepOnAcquire: boolean;
  private readonly crossProcessLocking: boolean;
  private readonly active = new Map<string, ActiveEntry>();
  /**
   * Sandboxes currently being acquired but not yet in `active`. Closes
   * the in-process race window between the initial check and the final
   * `active.set` — every `await` inside `acquire()` is a yield point
   * where another `acquire()` call could begin. Modified synchronously
   * before any await.
   */
  private readonly pending = new Set<string>();
  private initialized = false;

  constructor(opts: WorkspaceManagerOptions) {
    super();
    this.root = opts.root;
    this.defaults = opts.defaults;
    this.ttlMs = opts.ttlMs ?? 30 * 60_000;
    this.maxDiskBytes = opts.maxDiskBytes ?? Infinity;
    this.sweepOnAcquire = opts.sweepOnAcquire ?? true;
    this.crossProcessLocking = opts.crossProcessLocking ?? false;
  }

  on<E extends keyof WorkspaceManagerEvents>(event: E, listener: WorkspaceManagerEvents[E]): this {
    return super.on(event, listener);
  }

  off<E extends keyof WorkspaceManagerEvents>(event: E, listener: WorkspaceManagerEvents[E]): this {
    return super.off(event, listener);
  }

  emit<E extends keyof WorkspaceManagerEvents>(
    event: E,
    ...args: Parameters<WorkspaceManagerEvents[E]>
  ): boolean {
    return super.emit(event, ...args);
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await fsp.mkdir(join(this.root, "trees"), { recursive: true });
    await fsp.mkdir(join(this.root, "locks"), { recursive: true });
    await fsp.mkdir(join(this.root, "meta"), { recursive: true });
    this.initialized = true;
  }

  // ---------------------------------------------------------------------
  // acquire / release
  // ---------------------------------------------------------------------

  async acquire(
    sandboxId: string,
    configOverride?: Partial<SandboxConfig>,
  ): Promise<SandboxHandle> {
    validateSandboxId(sandboxId);

    // Synchronously claim the slot BEFORE any await. Closes the race
    // window where two concurrent acquire() calls could both pass the
    // `active.has` check before either populates `active`.
    if (this.active.has(sandboxId) || this.pending.has(sandboxId)) {
      throw new SandboxLockedError(sandboxId);
    }
    this.pending.add(sandboxId);

    try {
      await this.ensureInit();

      if (this.sweepOnAcquire) {
        await this.sweep();
      }

      const config = mergeConfig(this.defaults, configOverride);

      const treePath = join(this.root, "trees", sandboxId);
      const lockPath = join(this.root, "locks", `${sandboxId}.lock`);
      const metaPath = join(this.root, "meta", `${sandboxId}.json`);

      // Acquire cross-process lock (no-op when disabled).
      const lock = await acquireFileLock(lockPath, sandboxId, this.crossProcessLocking);

      let backend: SnapshotBackend | null = null;
      try {
        // Construct backend
        backend = await config.backendFactory(sandboxId);
        if (config.initializeBackend) await config.initializeBackend(backend);

        const treeExists = await directoryExists(treePath);
        await fsp.mkdir(treePath, { recursive: true });

        // Read meta if it exists
        const meta = await readMeta(metaPath, sandboxId);

        const inner = new DiskWorkingTree({ root: treePath });

        const fs = new PersistentFs<DiskWorkingTree>(inner, {
          backend,
          excludeFromSnapshots: config.excludeFromSnapshots,
          author: config.author,
        });

        // Boot — but skip restore if the cached tree is clean and already at backend HEAD.
        const backendHead = await backend.readHead();
        let warmBoot = false;
        if (meta.treeClean && backendHead === meta.lastBootedHead && treeExists) {
          warmBoot = true;
          fs.markCleanAtHead(backendHead);
        } else {
          await fs.boot();
          meta.lastBootedHead = fs.getKnownHead() ?? (await backend.readHead());
          meta.treeClean = true;
        }
        // From this point until release, a crash could leave uncommitted
        // mutations in the tree. Mark dirty pessimistically and only bless
        // the cache again during clean release.
        meta.lastActiveAt = Date.now();
        meta.treeClean = false;
        await writeMeta(metaPath, meta);

        let released = false;
        const releaseState = async (closeBackend: boolean): Promise<void> => {
          if (released) return;
          released = true;
          try {
            const updated = await readMeta(metaPath, sandboxId);
            if (fs.isDirty()) {
              updated.treeClean = false;
            } else {
              updated.lastBootedHead = fs.getKnownHead() ?? (await backend!.readHead());
              updated.treeClean = true;
            }
            updated.lastActiveAt = Date.now();
            await writeMeta(metaPath, updated);
          } finally {
            if (closeBackend) {
              try {
                await fs.close();
              } catch {}
              try {
                await backend!.close();
              } catch {}
            }
            await releaseFileLock(lock);
            this.active.delete(sandboxId);
            this.emit("release", sandboxId);
          }
        };
        const handle: SandboxHandle = {
          sandboxId,
          fs,
          treePath,
          release: async () => {
            await releaseState(false);
          },
          dispose: async () => {
            await releaseState(true);
          },
        };

        this.active.set(sandboxId, { handle, backend, lock });
        this.emit("acquire", sandboxId, { warmBoot });
        return handle;
      } catch (e) {
        try {
          await releaseFileLock(lock);
        } catch {}
        try {
          if (backend) await backend.close();
        } catch {}
        throw e;
      }
    } finally {
      this.pending.delete(sandboxId);
    }
  }

  // ---------------------------------------------------------------------
  // Eviction
  // ---------------------------------------------------------------------

  /**
   * Evict idle sandboxes: TTL first, then disk budget if still over.
   *
   * Returns the list of sandbox IDs that were evicted.
   */
  async sweep(): Promise<string[]> {
    await this.ensureInit();
    const evicted: string[] = [];
    const now = Date.now();
    const trees = join(this.root, "trees");
    let candidates: string[];
    try {
      candidates = await fsp.readdir(trees);
    } catch {
      return evicted;
    }

    // Build candidate list with metadata and sizes
    const info: Array<{ id: string; meta: SandboxMeta; sizeBytes: number }> = [];
    for (const id of candidates) {
      if (this.active.has(id) || this.pending.has(id)) continue; // never evict held sandboxes
      const treePath = join(trees, id);
      try {
        const st = await fsp.stat(treePath);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }

      const meta = await readMeta(join(this.root, "meta", `${id}.json`), id);

      // TTL check
      if (this.ttlMs > 0 && now - meta.lastActiveAt > this.ttlMs) {
        if (await this.tryEvictOne(id, "ttl")) evicted.push(id);
        continue;
      }

      // Candidate for disk-budget eviction
      const sizeBytes = await dirSizeBytes(treePath);
      info.push({ id, meta, sizeBytes });
    }

    // Disk budget: if total > max, evict oldest-first until under
    if (this.maxDiskBytes !== Infinity) {
      let total = info.reduce((s, e) => s + e.sizeBytes, 0);
      if (total > this.maxDiskBytes) {
        info.sort((a, b) => a.meta.lastActiveAt - b.meta.lastActiveAt);
        for (const entry of info) {
          if (total <= this.maxDiskBytes) break;
          if (await this.tryEvictOne(entry.id, "budget")) {
            evicted.push(entry.id);
            total -= entry.sizeBytes;
          }
        }
      }
    }

    this.emit("sweep", { scanned: candidates.length, evicted });
    return evicted;
  }

  /**
   * Attempt to evict one sandbox. In-process active/pending checks are
   * always enforced. When cross-process locking is enabled, the lockfile
   * also keeps other processes from acquiring the same tree mid-eviction.
   * Returns true on success.
   */
  private async tryEvictOne(sandboxId: string, reason: EvictReason): Promise<boolean> {
    if (this.active.has(sandboxId) || this.pending.has(sandboxId)) return false;
    const lockPath = join(this.root, "locks", `${sandboxId}.lock`);
    let lock: LockHandle;
    try {
      lock = await acquireFileLock(lockPath, sandboxId, this.crossProcessLocking);
    } catch {
      return false;
    }
    try {
      const treePath = join(this.root, "trees", sandboxId);
      const metaPath = join(this.root, "meta", `${sandboxId}.json`);
      await fsp.rm(metaPath, { force: true });
      await fsp.rm(treePath, { recursive: true, force: true });
      this.emit("evict", sandboxId, { reason });
      return true;
    } finally {
      await releaseFileLock(lock);
    }
  }

  /**
   * Explicitly evict a sandbox. Throws if the sandbox is currently
   * held (caller must release first).
   */
  async evict(sandboxId: string): Promise<void> {
    if (this.active.has(sandboxId)) {
      throw new SandboxLockedError(sandboxId);
    }
    await this.tryEvictOne(sandboxId, "explicit");
  }

  /**
   * Total bytes used by all tree directories.
   */
  async totalDiskBytes(): Promise<number> {
    await this.ensureInit();
    const trees = join(this.root, "trees");
    let entries: string[];
    try {
      entries = await fsp.readdir(trees);
    } catch {
      return 0;
    }
    let total = 0;
    for (const id of entries) {
      total += await dirSizeBytes(join(trees, id));
    }
    return total;
  }

  /**
   * Close the manager. Releases any still-held handles. Does NOT
   * evict trees (their durable state is in the backend; trees are
   * caches).
   */
  async close(): Promise<void> {
    const handles = [...this.active.values()];
    for (const e of handles) {
      try {
        await e.handle.dispose();
      } catch {}
    }
    this.active.clear();
  }
}

// =====================================================================
// Errors
// =====================================================================

export class SandboxLockedError extends Error {
  constructor(public readonly sandboxId: string) {
    super(`Sandbox '${sandboxId}' is currently held by another acquire`);
    this.name = "SandboxLockedError";
  }
}

// =====================================================================
// Internals
// =====================================================================

const SANDBOX_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;

function validateSandboxId(id: string): void {
  if (!SANDBOX_ID_RE.test(id)) {
    throw new Error(
      `Invalid sandboxId '${id}'. Must match ${SANDBOX_ID_RE} ` +
        `(alphanumeric, ., _, -, max 128 chars, no leading dot).`,
    );
  }
}

function mergeConfig(
  defaults: SandboxConfig | undefined,
  override: Partial<SandboxConfig> | undefined,
): SandboxConfig {
  const backendFactory = override?.backendFactory ?? defaults?.backendFactory;
  if (!backendFactory) {
    throw new Error("No backendFactory configured (provide defaults or pass to acquire)");
  }

  return {
    backendFactory,
    initializeBackend: override?.initializeBackend ?? defaults?.initializeBackend,
    excludeFromSnapshots: override?.excludeFromSnapshots ?? defaults?.excludeFromSnapshots,
    author: override?.author ?? defaults?.author,
  };
}

async function readMeta(path: string, sandboxId: string): Promise<SandboxMeta> {
  try {
    const text = await fsp.readFile(path, "utf8");
    const parsed = JSON.parse(text);
    return {
      sandboxId,
      lastBootedHead: parsed.lastBootedHead ?? null,
      treeClean: parsed.treeClean === true,
      lastActiveAt: Number(parsed.lastActiveAt) || Date.now(),
      createdAt: Number(parsed.createdAt) || Date.now(),
    };
  } catch {
    return {
      sandboxId,
      lastBootedHead: null,
      treeClean: false,
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
    };
  }
}

async function writeMeta(path: string, meta: SandboxMeta): Promise<void> {
  const tmp = path + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(meta));
  await fsp.rename(tmp, path);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const st = await fsp.lstat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Cross-process advisory lock.
 *
 * Node doesn't ship a flock(2) binding and we won't take a native
 * dependency. Instead we use a lockfile that combines:
 *
 *   - Atomic create via `open(path, 'wx')` (O_CREAT|O_EXCL). The first
 *     writer wins; the rest get EEXIST.
 *   - PID + nonce written inside the lockfile so we can identify the
 *     owner.
 *   - mtime heartbeat refreshed every LOCK_REFRESH_MS so concurrent
 *     processes can tell the owner is alive.
 *   - TTL-based takeover: a lockfile whose mtime hasn't been touched
 *     for LOCK_TTL_MS AND whose recorded PID is dead can be reclaimed.
 *     Reclaim uses a separate atomic guard file and re-checks the stale
 *     lock while holding that guard before removing it.
 *
 * Takeover race: multiple processes may simultaneously notice a stale
 * lock. Only one process can hold the reclaim guard at a time. Before
 * deleting anything, the guard holder re-stats and re-reads the lockfile;
 * late reclaimers therefore see the fresh replacement and fail correctly
 * with SandboxLockedError instead of deleting it.
 *
 * Crash safety: if the owning process dies without cleaning up, the
 * heartbeat stops and the lock ages out after LOCK_TTL_MS. The lockfile
 * itself remains on disk until reclaimed.
 *
 * Limitations:
 *   - PID liveness check via `process.kill(pid, 0)` can't distinguish
 *     "PID reused for a different program" from "PID is our lock
 *     owner." The mtime TTL is what really protects us — even if PID
 *     reuse confuses the alive-check, an old lockfile will age out.
 *   - NFS and other distributed filesystems may not have atomic
 *     O_CREAT|O_EXCL semantics. Don't put the lockfile on NFS.
 */

const LOCK_TTL_MS = 90_000;
const LOCK_REFRESH_MS = 30_000;
const LOCK_RETRY_LIMIT = 5;
const LOCK_RECLAIM_RETRY_MS = 10;

interface LockHandle {
  lockPath: string;
  fd: number;
  nonce: string;
  heartbeat: NodeJS.Timeout;
  released: boolean;
}

interface ReclaimGuard {
  path: string;
  fd: number;
  nonce: string;
}

async function acquireFileLock(
  lockPath: string,
  sandboxId: string,
  enabled: boolean,
): Promise<LockHandle> {
  if (!enabled) {
    // No-op lock for single-process deployments. Returns a sentinel
    // handle that releaseFileLock recognizes and skips.
    return {
      lockPath,
      fd: -1,
      nonce: "",
      heartbeat: null as unknown as NodeJS.Timeout,
      released: false,
    };
  }

  // The locks/ dir is created once by ensureInit(). No mkdir here.
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
    // Atomic create-or-fail.
    const created = tryCreateLockFile(lockPath, nonce);
    if (created) return created;

    // Lockfile exists. Decide whether to take over.
    let st: fs.Stats;
    try {
      st = await fsp.stat(lockPath);
    } catch (e: any) {
      if (e.code === "ENOENT") continue; // race: file vanished, retry create
      throw e;
    }
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs < LOCK_TTL_MS) {
      // Fresh lock — owned by a live process (or one that died very recently).
      throw new SandboxLockedError(sandboxId);
    }

    // Stale by mtime. Read the recorded PID and check liveness.
    const ownerPid = await readLockOwnerPid(lockPath);
    if (ownerPid !== null && isProcessAlive(ownerPid)) {
      // PID exists but mtime is stale. The process is alive but the
      // heartbeat isn't being refreshed — probably a stuck owner.
      // We refuse to steal in this case; safer to fail the acquire.
      throw new SandboxLockedError(sandboxId);
    }

    const reclaimGuard = await tryAcquireReclaimGuard(`${lockPath}.reclaim`, nonce);
    if (!reclaimGuard) {
      await sleep(LOCK_RECLAIM_RETRY_MS);
      continue;
    }

    try {
      const reclaimed = await reclaimStaleLock(lockPath, sandboxId, nonce);
      if (reclaimed) return reclaimed;
    } finally {
      await releaseReclaimGuard(reclaimGuard);
    }
  }

  throw new SandboxLockedError(sandboxId);
}

function tryCreateLockFile(lockPath: string, nonce: string): LockHandle | null {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
  } catch (e: any) {
    if (e.code === "EEXIST") return null;
    throw e;
  }

  try {
    fs.writeSync(fd, `${process.pid}\n${nonce}\n${Date.now()}\n`);
  } catch (e) {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(lockPath);
    } catch {}
    throw e;
  }

  // Heartbeat refreshes mtime so concurrent processes see the lock is
  // alive. Use unref() so this timer doesn't keep the process running.
  const heartbeat = setInterval(() => {
    const now = new Date();
    fsp.utimes(lockPath, now, now).catch(() => {});
  }, LOCK_REFRESH_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();
  return { lockPath, fd, nonce, heartbeat, released: false };
}

async function tryAcquireReclaimGuard(
  reclaimPath: string,
  nonce: string,
): Promise<ReclaimGuard | null> {
  let fd: number;
  try {
    fd = fs.openSync(reclaimPath, "wx", 0o600);
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    await removeStaleReclaimGuard(reclaimPath);
    try {
      fd = fs.openSync(reclaimPath, "wx", 0o600);
    } catch (retry: any) {
      if (retry.code === "EEXIST") return null;
      throw retry;
    }
  }

  try {
    fs.writeSync(fd, `${process.pid}\n${nonce}\n${Date.now()}\n`);
    return { path: reclaimPath, fd, nonce };
  } catch (e) {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(reclaimPath);
    } catch {}
    throw e;
  }
}

async function removeStaleReclaimGuard(reclaimPath: string): Promise<void> {
  let st: fs.Stats;
  try {
    st = await fsp.stat(reclaimPath);
  } catch (e: any) {
    if (e.code === "ENOENT") return;
    throw e;
  }

  if (Date.now() - st.mtimeMs < LOCK_TTL_MS) return;
  const ownerPid = await readLockOwnerPid(reclaimPath);
  if (ownerPid !== null && isProcessAlive(ownerPid)) return;

  try {
    await fsp.unlink(reclaimPath);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
}

async function reclaimStaleLock(
  lockPath: string,
  sandboxId: string,
  nonce: string,
): Promise<LockHandle | null> {
  let st: fs.Stats;
  try {
    st = await fsp.stat(lockPath);
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }

  if (Date.now() - st.mtimeMs < LOCK_TTL_MS) {
    throw new SandboxLockedError(sandboxId);
  }

  const ownerPid = await readLockOwnerPid(lockPath);
  if (ownerPid !== null && isProcessAlive(ownerPid)) {
    throw new SandboxLockedError(sandboxId);
  }

  try {
    await fsp.unlink(lockPath);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    return null;
  }

  return tryCreateLockFile(lockPath, nonce);
}

async function releaseReclaimGuard(guard: ReclaimGuard): Promise<void> {
  try {
    fs.closeSync(guard.fd);
  } catch {}
  try {
    const text = await fsp.readFile(guard.path, "utf8");
    if (text.includes(guard.nonce)) {
      await fsp.unlink(guard.path);
    }
  } catch {
    /* nothing to clean */
  }
}

async function readLockOwnerPid(lockPath: string): Promise<number | null> {
  try {
    const text = await fsp.readFile(lockPath, "utf8");
    const pidLine = text.split("\n")[0];
    const parsed = parseInt(pidLine, 10);
    return isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function releaseFileLock(lock: LockHandle): Promise<void> {
  if (lock.released) return;
  lock.released = true;
  // Sentinel from disabled mode: nothing to clean up.
  if (lock.fd === -1) return;
  clearInterval(lock.heartbeat);
  try {
    fs.closeSync(lock.fd);
  } catch {}
  // Verify the lockfile still has our nonce before deleting — paranoia
  // against the case where a stale-takeover incorrectly happened against us.
  try {
    const text = await fsp.readFile(lock.lockPath, "utf8");
    if (text.includes(lock.nonce)) {
      await fsp.unlink(lock.lockPath);
    }
  } catch {
    /* nothing to clean */
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    // Signal 0 is "don't actually signal, just check." Throws ESRCH
    // if the process doesn't exist, EPERM if it exists but we can't
    // signal it (still "alive" for our purposes).
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (p: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = p + sep + e.name;
      try {
        const st = await fsp.lstat(child);
        total += st.size;
        if (e.isDirectory()) await walk(child);
      } catch {
        /* skip */
      }
    }
  };
  await walk(dir);
  return total;
}
