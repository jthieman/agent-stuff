import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { SnapshotBackend } from "../backend.ts";
import type { DirentEntry, ReadFileOptions, WriteFileOptions } from "../just-bash-types.ts";
import type { SnapshotId, CommitInfo, DiffEntry } from "../types.ts";
import { CasConflictError } from "../types.ts";
import { clearFsContents, normalizeExcludePath } from "../walk.ts";

/**
 * Outcome from `PersistentFs.reconcile()` — describes the backend state
 * after a commit() call threw, so the caller can decide whether to retry.
 *
 *   conflict  Another writer won the CAS race. HEAD is what they
 *             committed. Definitely safe to retry from a fresh boot().
 *
 *   observed  Some other error (network, IO, etc.). HEAD is what
 *             the backend reports right now. The caller's job is to
 *             compare currentHead against the priorHead they saw
 *             before commit:
 *               - if currentHead === priorHead → commit definitely
 *                 didn't land; safe to retry
 *               - if currentHead !== priorHead → commit MAY have
 *                 landed; walk the chain to determine
 */
export type ReconcileOutcome =
  | { kind: "conflict"; actualHead: SnapshotId | null }
  | { kind: "observed"; currentHead: SnapshotId | null };

export interface PersistentFsOptions {
  /**
   * Where commits go. Pick one of the SnapshotBackend implementations
   * (GitBackend, BlobBackend, etc.) — just-stash is backend-agnostic.
   */
  backend: SnapshotBackend;

  /**
   * Virtual paths to exclude from snapshots. The agent sees them, writes
   * to them, reads from them — but they don't survive a commit/restore
   * cycle. Use for scratch directories.
   *
   * Paths are prefix-matched: '/scratch' excludes /scratch itself and
   * everything under it.
   */
  excludeFromSnapshots?: string[];

  /**
   * Commit author. Used for git commits; informational for blob backends.
   * Defaults to 'just-stash / just-stash@local'.
   */
  author?: { name: string; email: string };
}

export interface CommitOpts {
  /** Why this commit happened. Used for log filtering. */
  trigger: string;
  /** Human-readable commit message. Defaults to trigger. */
  message?: string;
  /** Optional harness metadata (prompts, model output, run IDs). */
  note?: string;
}

const DEFAULT_AUTHOR = { name: "just-stash", email: "just-stash@local" };

/**
 * Wraps any IFileSystem with restore/commit/fork/rollback against a
 * SnapshotBackend.
 *
 * Designed for ephemeral compute: the inner fs lives in process memory
 * (typically InMemoryFs or MountableFs of InMemoryFs), and the backend
 * is the durable source of truth.
 *
 *   const fs = new PersistentFs(inner, {
 *     backend: new GitBackend({ remote: { url, token } }),
 *     excludeFromSnapshots: ['/scratch'],
 *   });
 *   await fs.boot();
 *   // agent runs ...
 *   await fs.commit({ trigger: 'turn_end' });
 *   await fs.close();
 *
 * commit() is blocking and durable — when it returns, the snapshot is
 * persisted to the backend. There is no separate "push" step.
 */
export class PersistentFs<T extends IFileSystem = IFileSystem> implements IFileSystem {
  private readonly backend: SnapshotBackend;
  private readonly excludePrefixes: string[];
  private readonly author: { name: string; email: string };
  private knownHead: SnapshotId | null | undefined;
  private dirty = false;

  constructor(
    public readonly inner: T,
    opts: PersistentFsOptions,
  ) {
    this.backend = opts.backend;
    this.excludePrefixes = (opts.excludeFromSnapshots ?? []).map(normalizeExcludePath);
    this.author = opts.author ?? DEFAULT_AUTHOR;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Restore inner from the backend's current HEAD.
   *
   * Clears inner first — assumes inner is in-memory or disk-backed and
   * can be cleared. If the inner exposes a `clear()` method (e.g.
   * DiskWorkingTree), we use that as a fast path; otherwise we walk
   * via the IFileSystem API.
   *
   * If you need to start from a non-empty state, don't use boot() —
   * populate inner manually and start with commit() instead.
   */
  async boot(): Promise<void> {
    const head = await this.backend.readHead();
    this.knownHead = undefined;
    this.dirty = true;
    // Fast path: if inner is DiskWorkingTree (or anything with .clear()),
    // use it. Avoids O(n) readdir+rm via IFileSystem.
    const fastClear = (this.inner as any).clear;
    if (typeof fastClear === "function") {
      await fastClear.call(this.inner);
    } else {
      await clearFsContents(this.inner);
    }
    if (head === null) {
      this.knownHead = null;
      this.dirty = false;
      return;
    }
    await this.backend.restore(head, this.inner);
    this.knownHead = head;
    this.dirty = false;
  }

  /**
   * Snapshot the inner fs and durably persist.
   *
   * Atomic with CAS — if another process committed since this fs booted
   * (or last committed), this throws CasConflictError. Caller can retry.
   */
  async commit(opts: CommitOpts): Promise<CommitInfo> {
    const priorHead = this.knownHead === undefined ? await this.backend.readHead() : this.knownHead;
    const info = await this.backend.commit({
      fs: this.inner,
      excludePaths: this.excludePrefixes,
      priorHead,
      metadata: {
        trigger: opts.trigger,
        message: opts.message ?? opts.trigger,
        author: this.author,
        timestamp: Date.now(),
      },
    });
    this.knownHead = info.snapshotId;
    this.dirty = false;
    if (opts.note) {
      await this.backend.addNote(info.snapshotId, opts.note);
    }
    return info;
  }

  /**
   * Roll back to a previous snapshot. Restores inner and moves HEAD
   * in the backend. The intermediate commits remain in history; this is
   * not a destructive operation (history isn't rewritten — HEAD just
   * moves back).
   */
  async rollback(snapshotId: SnapshotId): Promise<void> {
    const priorHead = this.knownHead === undefined ? await this.backend.readHead() : this.knownHead;
    if (!priorHead) {
      throw new Error("Cannot rollback: backend has no HEAD");
    }
    await this.backend.rollback(snapshotId, priorHead);
    this.knownHead = undefined;
    this.dirty = true;
    const fastClear = (this.inner as any).clear;
    if (typeof fastClear === "function") {
      await fastClear.call(this.inner);
    } else {
      await clearFsContents(this.inner);
    }
    await this.backend.restore(snapshotId, this.inner);
    this.knownHead = snapshotId;
    this.dirty = false;
  }

  /**
   * List commit history, newest first.
   */
  log(opts?: { limit?: number; since?: SnapshotId }): Promise<CommitInfo[]> {
    return this.backend.log(opts);
  }

  /**
   * Diff two snapshots, or the given snapshot against current HEAD.
   */
  diff(from: SnapshotId, to?: SnapshotId): Promise<DiffEntry[]> {
    return this.backend.diff(from, to);
  }

  /**
   * Attach or read harness metadata for a commit.
   */
  addNote(snapshotId: SnapshotId, note: string): Promise<void> {
    return this.backend.addNote(snapshotId, note);
  }
  getNote(snapshotId: SnapshotId): Promise<string | null> {
    return this.backend.getNote(snapshotId);
  }

  /**
   * After a commit() call threw, determine what actually happened
   * on the backend. Useful when the failure could be either "never
   * advanced HEAD" (definitely failed) or "HEAD advanced but we
   * didn't get the response" (actually succeeded).
   *
   *   try {
   *     await fs.commit({ trigger: 'turn_end' });
   *   } catch (e) {
   *     const outcome = await fs.reconcile(e);
   *     switch (outcome.kind) {
   *       case 'observed':  // compare outcome.currentHead with your
   *                         // last known HEAD to decide whether it moved
   *       case 'conflict':  // CAS conflict; another writer won
   *     }
   *   }
   *
   * This is NOT a magic "did my commit succeed" oracle — the backend
   * has no way to tell. It tells you the OBSERVABLE state of HEAD
   * and lets you make the call.
   *
   * Pair with the recommendation: walk `log()` after an observed
   * HEAD change and check whether the new HEAD's content matches
   * what you intended.
   */
  async reconcile(error: unknown): Promise<ReconcileOutcome> {
    if (error instanceof CasConflictError) {
      return { kind: "conflict", actualHead: error.actualHead };
    }
    const currentHead = await this.backend.readHead();
    // We don't know what HEAD was before the failed commit, so we can't
    // tell "advanced" from "unchanged" without caller-supplied context.
    // The caller compares this against their last-known-good HEAD.
    return { kind: "observed", currentHead };
  }

  /**
   * Close the wrapper. Does NOT close the backend — backend lifecycle is
   * the caller's responsibility (it may be shared across multiple
   * PersistentFs instances).
   */
  async close(): Promise<void> {
    // currently a no-op; reserved for future use (e.g. background workers)
  }

  /**
   * Mark this wrapper as known-clean at a backend HEAD without performing
   * a restore. Used by WorkspaceManager after it has decided a cached tree
   * can be trusted for warm boot.
   */
  markCleanAtHead(head: SnapshotId | null): void {
    this.knownHead = head;
    this.dirty = false;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  getKnownHead(): SnapshotId | null | undefined {
    return this.knownHead;
  }

  private markDirty(): void {
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Forking
  // -------------------------------------------------------------------------

  /**
   * Fork a session.
   *
   * If the destination backend implements native fork (e.g. git refs,
   * Cloudflare Artifacts native fork), uses that. Otherwise falls back
   * to "snapshot current state, restore into a new fs+backend pair."
   *
   * Returns a new PersistentFs ready to use.
   */
  static async fork<T extends IFileSystem>(opts: {
    src: PersistentFs<IFileSystem>;
    dst: SnapshotBackend;
    innerFactory: () => T;
    excludeFromSnapshots?: string[];
    author?: { name: string; email: string };
  }): Promise<PersistentFs<T>> {
    // Try native fork
    if (opts.src.backend.fork) {
      await opts.src.backend.fork(opts.dst);
    } else {
      // Fallback: take a snapshot of current inner, replay into dst
      const inner = opts.innerFactory();
      const priorHead = await opts.dst.readHead();
      const srcHead = await opts.src.backend.readHead();
      if (srcHead === null) {
        // src has no commits yet; dst stays empty
      } else {
        // Replay src state into a temporary fs then commit to dst
        await opts.src.backend.restore(srcHead, inner);
        await opts.dst.commit({
          fs: inner,
          excludePaths: (opts.excludeFromSnapshots ?? []).map(normalizeExcludePath),
          priorHead,
          metadata: {
            trigger: "fork",
            message: "fork",
            author: opts.author ?? DEFAULT_AUTHOR,
            timestamp: Date.now(),
          },
        });
      }
    }

    const fs = new PersistentFs(opts.innerFactory(), {
      backend: opts.dst,
      excludeFromSnapshots: opts.excludeFromSnapshots,
      author: opts.author,
    });
    await fs.boot();
    return fs;
  }

  // -------------------------------------------------------------------------
  // IFileSystem delegation
  // -------------------------------------------------------------------------

  readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    return this.inner.readFile(path, options);
  }
  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.inner.readFileBuffer(path);
  }
  writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    return this.inner.writeFile(path, content, options).then(() => this.markDirty());
  }
  appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    return this.inner.appendFile(path, content, options).then(() => this.markDirty());
  }
  exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }
  stat(path: string): Promise<FsStat> {
    return this.inner.stat(path);
  }
  lstat(path: string): Promise<FsStat> {
    return this.inner.lstat(path);
  }
  mkdir(path: string, options?: MkdirOptions): Promise<void> {
    return this.inner.mkdir(path, options).then(() => this.markDirty());
  }
  readdir(path: string): Promise<string[]> {
    return this.inner.readdir(path);
  }
  readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    if (!this.inner.readdirWithFileTypes)
      throw new Error("Inner fs does not support readdirWithFileTypes");
    return this.inner.readdirWithFileTypes(path);
  }
  rm(path: string, options?: RmOptions): Promise<void> {
    return this.inner.rm(path, options).then(() => this.markDirty());
  }
  cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    return this.inner.cp(src, dest, options).then(() => this.markDirty());
  }
  mv(src: string, dest: string): Promise<void> {
    return this.inner.mv(src, dest).then(() => this.markDirty());
  }
  resolvePath(base: string, path: string): string {
    return this.inner.resolvePath(base, path);
  }
  getAllPaths(): string[] {
    return this.inner.getAllPaths();
  }
  chmod(path: string, mode: number): Promise<void> {
    return this.inner.chmod(path, mode).then(() => this.markDirty());
  }
  symlink(target: string, linkPath: string): Promise<void> {
    return this.inner.symlink(target, linkPath).then(() => this.markDirty());
  }
  link(existingPath: string, newPath: string): Promise<void> {
    return this.inner.link(existingPath, newPath).then(() => this.markDirty());
  }
  readlink(path: string): Promise<string> {
    return this.inner.readlink(path);
  }
  realpath(path: string): Promise<string> {
    return this.inner.realpath(path);
  }
  utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    return this.inner.utimes(path, atime, mtime).then(() => this.markDirty());
  }
}
