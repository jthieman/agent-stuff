import * as fs from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import git from "isomorphic-git";
import type { IFileSystem } from "just-bash";
import type { SnapshotBackend } from "../backend.ts";
import type { SnapshotId, CommitInfo, CommitMetadata, DiffEntry } from "../types.ts";
import { CasConflictError } from "../types.ts";
import { walkSnapshot } from "../walk.ts";

export interface GitBackendOptions {
  /**
   * Path to a bare git repo on disk. If omitted, just-stash creates a
   * temporary directory and cleans it up on close().
   *
   * Use a stable path for caching across process restarts. Use a tmpfs
   * path on ephemeral compute. Leave undefined for fully ephemeral
   * (everything is recreated on each run).
   */
  cacheDir?: string;

  /**
   * Remote git server to sync to. If provided, commit() pushes to it
   * and boot() fetches from it. If omitted, the local cacheDir IS the
   * source of truth.
   *
   * For ephemeral compute deployments, ALWAYS set a remote — local
   * cacheDir disappears with the container.
   */
  remote?: {
    url: string;
    /** OAuth-style bearer token, basic auth password, etc. */
    token?: string;
    /** Username for basic auth. Default 'token'. */
    username?: string;
    /** HTTP client. Pass isomorphic-git/http/node by default. */
    http?: any;
  };

  /** Branch ref to use as HEAD. Default 'main'. */
  branch?: string;
}

const DEFAULT_BRANCH = "main";
const NOTES_REF = "refs/notes/just-stash";

/**
 * Git-native SnapshotBackend.
 *
 * Snapshots are git commits. The session is a single linear branch.
 * Forks are new repos with the source's HEAD copied.
 *
 *   // Local-only (single node)
 *   const backend = new GitBackend({ cacheDir: './alice.git' });
 *
 *   // Remote-backed (ephemeral compute)
 *   const backend = new GitBackend({
 *     remote: { url: 'https://artifacts.cloudflare.com/.../alice.git', token },
 *     cacheDir: '/tmp/just-stash-alice',  // optional tmpfs cache
 *   });
 *
 * Implementation notes:
 *
 *   - Uses isomorphic-git for all git operations
 *   - Bare repo on disk; in-memory mode is "temp dir we own"
 *   - CAS uses 'force-with-lease' semantics: push only succeeds if
 *     remote ref matches the expected old value
 *   - Notes (harness metadata) stored under refs/notes/just-stash
 *   - Snapshot ID = commit OID (SHA-1 hex)
 *   - Excluded paths walked-around via the same shared walkSnapshot helper
 *     used by BlobBackend
 */
export class GitBackend implements SnapshotBackend {
  private readonly opts: GitBackendOptions;
  private readonly branch: string;
  private gitdir: string;
  private ownedTmpDir: string | null = null;
  private readonly httpClient: any;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(opts: GitBackendOptions) {
    this.opts = opts;
    this.branch = opts.branch ?? DEFAULT_BRANCH;
    this.httpClient = opts.remote?.http;

    if (opts.cacheDir) {
      this.gitdir = opts.cacheDir;
    } else {
      this.ownedTmpDir = mkdtempSync(join(tmpdir(), "just-stash-git-"));
      this.gitdir = this.ownedTmpDir;
    }
  }

  /** Open or initialize the repo. */
  async initialize(): Promise<void> {
    const needInit = !existsSync(join(this.gitdir, "HEAD"));
    if (needInit) {
      await git.init({ fs, dir: this.gitdir, bare: true, defaultBranch: this.branch });
    }
    // Set HEAD to our branch if not already
    try {
      await git.resolveRef({ fs, gitdir: this.gitdir, ref: "HEAD" });
    } catch {
      // No HEAD yet — write a symbolic ref
      await git.writeRef({
        fs,
        gitdir: this.gitdir,
        ref: "HEAD",
        value: `ref: refs/heads/${this.branch}`,
        force: true,
        symbolic: true,
      } as any);
    }

    if (this.opts.remote) {
      await git.addRemote({
        fs,
        gitdir: this.gitdir,
        remote: "origin",
        url: this.opts.remote.url,
        force: true,
      });
      await this.syncFromRemote();
    }
  }

  async close(): Promise<void> {
    if (this.ownedTmpDir) {
      try {
        rmSync(this.ownedTmpDir, { recursive: true, force: true });
      } catch {}
      this.ownedTmpDir = null;
    }
  }

  // --- HEAD ---

  async readHead(): Promise<SnapshotId | null> {
    await this.mutationQueue;
    return this.readSyncedHead();
  }

  private async readSyncedHead(): Promise<SnapshotId | null> {
    await this.syncFromRemote();
    return this.readLocalHead();
  }

  private async readLocalHead(): Promise<SnapshotId | null> {
    try {
      const oid = await git.resolveRef({ fs, gitdir: this.gitdir, ref: this.branch });
      return oid as SnapshotId;
    } catch {
      return null;
    }
  }

  // --- Restore ---

  async restore(snapshotId: SnapshotId, into: IFileSystem): Promise<void> {
    const { commit } = await git.readCommit({ fs, gitdir: this.gitdir, oid: snapshotId });
    await this.restoreTree(commit.tree, "/", into);
  }

  private async restoreTree(
    treeOid: string,
    virtualPath: string,
    into: IFileSystem,
  ): Promise<void> {
    if (virtualPath !== "/") {
      await into.mkdir(virtualPath, { recursive: true });
    }
    const { tree } = await git.readTree({ fs, gitdir: this.gitdir, oid: treeOid });
    for (const entry of tree) {
      const childPath = virtualPath === "/" ? `/${entry.path}` : `${virtualPath}/${entry.path}`;
      if (entry.type === "tree") {
        await this.restoreTree(entry.oid, childPath, into);
      } else if (entry.type === "blob") {
        const { blob } = await git.readBlob({ fs, gitdir: this.gitdir, oid: entry.oid });
        await into.writeFile(childPath, Buffer.from(blob));
      }
      // Skip submodules ('commit' type) and other non-content entries
    }
  }

  // --- Commit ---

  async commit(opts: {
    fs: IFileSystem;
    excludePaths: string[];
    priorHead: SnapshotId | null;
    metadata: CommitMetadata;
  }): Promise<CommitInfo> {
    return this.runMutation(async () => {
      // 1. Walk inner fs and build trees + blobs
      const rootTreeOid = await this.snapshotDir("/", opts.fs, opts.excludePaths);

      // 2. CAS check
      const currentHead = await this.readSyncedHead();
      if (currentHead !== opts.priorHead) {
        throw new CasConflictError(opts.priorHead, currentHead);
      }

      // 3. Write commit object
      const commitOid = await git.commit({
        fs,
        gitdir: this.gitdir,
        ref: this.branch,
        tree: rootTreeOid,
        parent: opts.priorHead ? [opts.priorHead] : [],
        author: {
          name: opts.metadata.author.name,
          email: opts.metadata.author.email,
          timestamp: Math.floor(opts.metadata.timestamp / 1000),
          timezoneOffset: 0,
        },
        message: opts.metadata.message,
      });

      // 4. Push to remote (if configured)
      if (this.opts.remote) {
        try {
          await this.pushToRemote();
        } catch (e) {
          // Roll back the local ref so subsequent commits don't compound
          if (opts.priorHead) {
            await this.writeLocalHead(opts.priorHead);
          } else {
            await this.deleteLocalHead();
          }
          await this.throwRemoteConflictIfPushRejected(e, opts.priorHead);
        }
      }

      return {
        snapshotId: commitOid as SnapshotId,
        parentId: opts.priorHead,
        trigger: opts.metadata.trigger,
        message: opts.metadata.message,
        author: opts.metadata.author,
        timestamp: opts.metadata.timestamp,
      };
    });
  }

  private async runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async writeLocalHead(target: SnapshotId): Promise<void> {
    await git.writeRef({
      fs,
      gitdir: this.gitdir,
      ref: this.branch,
      value: target,
      force: true,
    });
  }

  private async deleteLocalHead(): Promise<void> {
    await git
      .deleteRef({ fs, gitdir: this.gitdir, ref: `refs/heads/${this.branch}` })
      .catch(() => {});
  }

  private async deleteLocalNotesRef(): Promise<void> {
    await git.deleteRef({ fs, gitdir: this.gitdir, ref: NOTES_REF }).catch(() => {});
  }

  private async snapshotDir(
    rootPath: string,
    sourceFs: IFileSystem,
    excludePaths: string[],
  ): Promise<string> {
    // Build a tree by walking the source fs
    // Collect entries per directory, then write trees bottom-up.
    type Entry = { type: "blob" | "tree"; mode: string; path: string; oid: string };
    const entriesByDir = new Map<string, Entry[]>();

    // Ensure root has at least an empty entries list
    entriesByDir.set(rootPath, []);

    await walkSnapshot(sourceFs, rootPath, excludePaths, async (entry) => {
      const parent = parentOf(entry.path);
      if (!entriesByDir.has(parent)) entriesByDir.set(parent, []);

      if (entry.isFile) {
        const content = await sourceFs.readFileBuffer(entry.path);
        const oid = await git.writeBlob({ fs, gitdir: this.gitdir, blob: Buffer.from(content) });
        entriesByDir.get(parent)!.push({
          type: "blob",
          mode: "100644",
          path: entry.name,
          oid,
        });
      } else if (entry.isDirectory) {
        // Pre-register empty entries list so we know to write the tree later
        if (!entriesByDir.has(entry.path)) entriesByDir.set(entry.path, []);
      }
    });

    // Write trees bottom-up. Sort directories by depth desc.
    // Depth = number of non-empty path segments. '/' = 0, '/data' = 1, '/a/b' = 2.
    const depth = (p: string) => p.split("/").filter(Boolean).length;
    const dirs = [...entriesByDir.keys()].sort((a, b) => depth(b) - depth(a));
    const treeOidByDir = new Map<string, string>();

    for (const dir of dirs) {
      const childEntries = entriesByDir.get(dir)!;
      // Add tree entries for any subdirectories of this dir
      // (subdirs were registered during the walk and now have OIDs)
      // Build by scanning entriesByDir for paths whose parent === dir
      // (cheap; the map is small)
      for (const otherDir of entriesByDir.keys()) {
        if (parentOf(otherDir) === dir && otherDir !== dir) {
          const oid = treeOidByDir.get(otherDir);
          if (oid !== undefined) {
            childEntries.push({
              type: "tree",
              mode: "040000",
              path: basenameOf(otherDir),
              oid,
            });
          }
        }
      }
      childEntries.sort((a, b) => a.path.localeCompare(b.path));
      const oid = await git.writeTree({
        fs,
        gitdir: this.gitdir,
        tree: childEntries.map((e) => ({ mode: e.mode, path: e.path, oid: e.oid, type: e.type })),
      });
      treeOidByDir.set(dir, oid);
    }

    return treeOidByDir.get(rootPath)!;
  }

  // --- Rollback ---

  async rollback(target: SnapshotId, priorHead: SnapshotId): Promise<void> {
    await this.runMutation(async () => {
      const current = await this.readSyncedHead();
      if (current !== priorHead) {
        throw new CasConflictError(priorHead, current);
      }
      // Verify target exists
      try {
        await git.readCommit({ fs, gitdir: this.gitdir, oid: target });
      } catch {
        throw new Error(`Cannot set HEAD: unknown commit ${target}`);
      }
      await this.writeLocalHead(target);
      if (this.opts.remote) {
        try {
          await this.pushToRemote({ force: true, expectedRemoteHead: priorHead });
        } catch (e) {
          await this.writeLocalHead(priorHead);
          if (e instanceof CasConflictError) throw e;
          await this.throwRemoteConflictIfPushRejected(e, priorHead);
        }
      }
    });
  }

  // --- Lookup ---

  async getCommit(snapshotId: SnapshotId): Promise<CommitInfo | null> {
    try {
      const { commit } = await git.readCommit({ fs, gitdir: this.gitdir, oid: snapshotId });
      return {
        snapshotId,
        parentId: (commit.parent[0] as SnapshotId | undefined) ?? null,
        trigger: commit.message.split("\n")[0],
        message: commit.message,
        author: { name: commit.author.name, email: commit.author.email },
        timestamp: commit.author.timestamp * 1000,
      };
    } catch {
      return null;
    }
  }

  // --- Log ---

  async log(opts?: { limit?: number; since?: SnapshotId }): Promise<CommitInfo[]> {
    const head = await this.readHead();
    if (!head) return [];
    const commits = await git.log({
      fs,
      gitdir: this.gitdir,
      ref: this.branch,
      depth: opts?.limit,
    });
    const result: CommitInfo[] = [];
    for (const c of commits) {
      if (opts?.since && c.oid === opts.since) break;
      result.push({
        snapshotId: c.oid as SnapshotId,
        parentId: (c.commit.parent[0] as SnapshotId | undefined) ?? null,
        trigger: c.commit.message.split("\n")[0],
        message: c.commit.message,
        author: { name: c.commit.author.name, email: c.commit.author.email },
        timestamp: c.commit.author.timestamp * 1000,
      });
    }
    return result;
  }

  // --- Diff ---

  async diff(from: SnapshotId, to?: SnapshotId): Promise<DiffEntry[]> {
    const toId = to ?? (await this.readHead());
    if (!toId) throw new Error("Cannot diff: no HEAD");

    const fromMap = await this.flattenTree(from);
    const toMap = await this.flattenTree(toId);

    const result: DiffEntry[] = [];
    for (const [path, oid] of toMap) {
      const fromOid = fromMap.get(path);
      if (fromOid === undefined) result.push({ path, kind: "added" });
      else if (fromOid !== oid) result.push({ path, kind: "modified" });
    }
    for (const path of fromMap.keys()) {
      if (!toMap.has(path)) result.push({ path, kind: "removed" });
    }
    result.sort((a, b) => a.path.localeCompare(b.path));
    return result;
  }

  private async flattenTree(commitOid: string): Promise<Map<string, string>> {
    const { commit } = await git.readCommit({ fs, gitdir: this.gitdir, oid: commitOid });
    const result = new Map<string, string>();
    const walk = async (treeOid: string, prefix: string): Promise<void> => {
      const { tree } = await git.readTree({ fs, gitdir: this.gitdir, oid: treeOid });
      for (const entry of tree) {
        const path = prefix === "" ? `/${entry.path}` : `${prefix}/${entry.path}`;
        if (entry.type === "tree") await walk(entry.oid, path);
        else if (entry.type === "blob") result.set(path, entry.oid);
      }
    };
    await walk(commit.tree, "");
    return result;
  }

  // --- Notes ---

  async addNote(snapshotId: SnapshotId, note: string): Promise<void> {
    await this.runMutation(async () => {
      await this.fetchNotesFromRemote();
      await this.addLocalNote(snapshotId, note);
      if (this.opts.remote) {
        try {
          await this.pushNotesToRemote();
        } catch (e) {
          if (!isNonFastForwardPushRejection(e)) throw e;
          await this.fetchNotesFromRemote();
          await this.addLocalNote(snapshotId, note);
          await this.pushNotesToRemote();
        }
      }
    });
  }

  async getNote(snapshotId: SnapshotId): Promise<string | null> {
    await this.mutationQueue;
    await this.fetchNotesFromRemote();
    try {
      const note = await git.readNote({
        fs,
        gitdir: this.gitdir,
        ref: NOTES_REF,
        oid: snapshotId,
      });
      return typeof note === "string" ? note : Buffer.from(note).toString("utf8");
    } catch {
      return null;
    }
  }

  private async addLocalNote(snapshotId: SnapshotId, note: string): Promise<void> {
    await git.addNote({
      fs,
      gitdir: this.gitdir,
      ref: NOTES_REF,
      oid: snapshotId,
      note,
      force: true,
      author: { name: "just-stash", email: "just-stash@local" },
    });
  }

  // --- Fork (native) ---

  async fork(dst: SnapshotBackend): Promise<void> {
    if (!(dst instanceof GitBackend)) {
      // Fall back: PersistentFs.fork will use snapshot+restore
      throw new Error("GitBackend.fork only supported between two GitBackend instances");
    }
    const head = await this.readHead();
    if (!head) return; // empty source — dst stays empty

    // Initialize dst if not yet done
    await dst.initialize().catch(() => {});

    // Walk source's commit chain and copy objects to dst.
    // The simplest correct approach: serialize source's pack and unpack
    // into dst. For now, walk and copy via low-level read/write.
    await this.copyObjectsTo(dst, head);

    // Advance dst's branch ref to the same commit
    await git.writeRef({
      fs,
      gitdir: dst.gitdir,
      ref: dst.branch,
      value: head,
      force: true,
    });

    if (dst.opts.remote) await dst.pushToRemote();
  }

  private async copyObjectsTo(dst: GitBackend, oid: string): Promise<void> {
    const visited = new Set<string>();
    const copyObject = async (objOid: string): Promise<void> => {
      if (visited.has(objOid)) return;
      visited.add(objOid);
      // Try commit first
      try {
        const { commit } = await git.readCommit({ fs, gitdir: this.gitdir, oid: objOid });
        // Copy parent commits
        for (const p of commit.parent) await copyObject(p);
        // Copy tree
        await copyTree(commit.tree);
        // Write commit to dst
        await git.writeCommit({ fs, gitdir: dst.gitdir, commit });
        return;
      } catch {
        /* not a commit */
      }
    };
    const copyTree = async (treeOid: string): Promise<void> => {
      if (visited.has(treeOid)) return;
      visited.add(treeOid);
      const { tree } = await git.readTree({ fs, gitdir: this.gitdir, oid: treeOid });
      for (const entry of tree) {
        if (entry.type === "tree") await copyTree(entry.oid);
        else if (entry.type === "blob") await copyBlob(entry.oid);
      }
      await git.writeTree({ fs, gitdir: dst.gitdir, tree: tree as any });
    };
    const copyBlob = async (blobOid: string): Promise<void> => {
      if (visited.has(blobOid)) return;
      visited.add(blobOid);
      const { blob } = await git.readBlob({ fs, gitdir: this.gitdir, oid: blobOid });
      await git.writeBlob({ fs, gitdir: dst.gitdir, blob });
    };
    await copyObject(oid);
  }

  // --- Remote sync ---

  private async syncFromRemote(): Promise<void> {
    if (!this.opts.remote) return;
    if (!existsSync(join(this.gitdir, "HEAD"))) return;
    await this.fetchBranchFromRemote();
    await this.fetchNotesFromRemote();
  }

  private async fetchBranchFromRemote(): Promise<void> {
    if (!this.opts.remote) return;
    const found = await this.fetchRefFromRemote(`refs/heads/${this.branch}`, this.branch);
    if (!found) await this.deleteLocalHead();
  }

  private async fetchNotesFromRemote(): Promise<void> {
    if (!this.opts.remote) return;
    const found = await this.fetchRefFromRemote(NOTES_REF, NOTES_REF);
    if (!found) await this.deleteLocalNotesRef();
  }

  private async fetchRefFromRemote(remoteRef: string, localRef: string): Promise<boolean> {
    if (!this.opts.remote) return false;
    const refs = await git.listServerRefs({
      http: this.requireHttp(),
      url: this.opts.remote.url,
      prefix: remoteRef,
      onAuth: this.authCallback(),
    });
    const match = refs.find((ref) => ref.ref === remoteRef);
    if (!match) return false;

    const result = await git.fetch({
      fs,
      http: this.requireHttp(),
      gitdir: this.gitdir,
      url: this.opts.remote.url,
      ref: localRef,
      remoteRef,
      onAuth: this.authCallback(),
      singleBranch: true,
    });
    await git.writeRef({
      fs,
      gitdir: this.gitdir,
      ref: localRef,
      value: result.fetchHead ?? match.oid,
      force: true,
    });
    return true;
  }

  private async pushToRemote(
    opts: {
      force?: boolean;
      expectedRemoteHead?: SnapshotId | null;
    } = {},
  ): Promise<void> {
    if (!this.opts.remote) return;
    const expectedRemoteHead = opts.expectedRemoteHead;
    // Normal commits use non-force push: the remote rejects if it has
    // advanced. Rollback intentionally moves the branch backward, so it
    // uses force plus an explicit advertised-ref lease. The receive-pack
    // protocol still sends the advertised old oid, so the server rejects
    // if the ref changes between advertisement and update.
    await git.push({
      fs,
      http: this.requireHttp(),
      gitdir: this.gitdir,
      ref: this.branch,
      remoteRef: `refs/heads/${this.branch}`,
      url: this.opts.remote.url,
      force: opts.force,
      onAuth: this.authCallback(),
      onPrePush:
        expectedRemoteHead === undefined
          ? undefined
          : ({ remoteRef }: { remoteRef: { oid?: string } }) => {
              const actual = normalizeAdvertisedOid(remoteRef?.oid);
              if (actual !== expectedRemoteHead) {
                throw new CasConflictError(expectedRemoteHead, actual);
              }
              return true;
            },
    });
  }

  private async pushNotesToRemote(): Promise<void> {
    if (!this.opts.remote) return;
    await git.push({
      fs,
      http: this.requireHttp(),
      gitdir: this.gitdir,
      ref: NOTES_REF,
      remoteRef: NOTES_REF,
      url: this.opts.remote.url,
      onAuth: this.authCallback(),
    });
  }

  private async throwRemoteConflictIfPushRejected(
    error: unknown,
    expectedHead: SnapshotId | null,
  ): Promise<never> {
    if (isNonFastForwardPushRejection(error)) {
      await this.fetchBranchFromRemote();
      throw new CasConflictError(expectedHead, await this.readLocalHead());
    }
    throw error;
  }

  private requireHttp(): any {
    if (!this.httpClient) {
      throw new Error(
        "GitBackend.remote configured but no http client. " +
          "Pass http from isomorphic-git/http/node or isomorphic-git/http/web.",
      );
    }
    return this.httpClient;
  }

  private authCallback() {
    const remote = this.opts.remote;
    if (!remote || !remote.token) return undefined;
    return () => ({
      username: remote.username ?? "token",
      password: remote.token,
    });
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function parentOf(path: string): string {
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  if (idx === 0) return "/";
  return path.slice(0, idx);
}

function basenameOf(path: string): string {
  if (path === "/") return "";
  const idx = path.lastIndexOf("/");
  return path.slice(idx + 1);
}

function normalizeAdvertisedOid(oid: string | undefined): SnapshotId | null {
  if (!oid || /^0{40}$/.test(oid)) return null;
  return oid as SnapshotId;
}

function isNonFastForwardPushRejection(error: unknown): boolean {
  const err = error as { code?: string; data?: { reason?: string }; message?: string };
  if (err.code !== "PushRejectedError") return false;
  if (err.data?.reason === "not-fast-forward") return true;
  return /non-fast-forward|not[ -]fast[ -]forward/i.test(err.message ?? "");
}
