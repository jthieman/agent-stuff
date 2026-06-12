import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import { dirname, sep, posix } from "node:path";
import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { DirentEntry, ReadFileOptions, WriteFileOptions } from "../just-bash-types.ts";
import { normalizeVirtualPath, joinToRoot, resolveRoot, makeEnoent } from "./paths.ts";

export interface DiskWorkingTreeOptions {
  /**
   * Absolute path to the directory that will back this filesystem.
   * Must exist and be a directory. Will be resolved through symlinks
   * once at construction; the resolved path is then fixed and used
   * for all lexical containment checks.
   *
   * EVERYTHING under this directory is owned by the filesystem.
   * Restore operations may clear it. Don't point it at anything you
   * care about outside of an just-stash session.
   */
  root: string;
}

/**
 * IFileSystem backed by a real on-disk directory, with strict escape
 * prevention.
 *
 * Security model:
 *
 *   1. Input paths are normalized; '..' segments and null bytes are
 *      rejected outright (ENOENT).
 *   2. The resolved root is fixed at construction. All path operations
 *      lexically join onto it and must not escape.
 *   3. Symlinks are never followed during traversal. lstat — not stat —
 *      is used to check every component. If any intermediate component
 *      is a symlink, the operation fails as if the path doesn't exist.
 *   4. Symlink creation is permitted but the link's target is required
 *      to be a relative path that, resolved lexically, stays inside
 *      the root. Absolute targets are rejected.
 *   5. Hard links between sandboxed paths are allowed; hard links to
 *      anything outside aren't possible because every path resolves
 *      inside the root.
 *
 * This means an agent (or a buggy built-in command going through
 * IFileSystem) cannot:
 *   - Read /etc/passwd via any path manipulation
 *   - Write to /tmp by writing to a symlink
 *   - Discover the on-disk layout outside the root via realpath
 *
 * What we do NOT defend against:
 *   - Out-of-band access (the harness opening files via raw fs)
 *   - Resource exhaustion (use SizeLimitedFs on top for that)
 *   - Time-of-check/time-of-use within a single op — we do segment-by-
 *     segment lstat, but a concurrent mutator could theoretically swap
 *     a segment between our check and our use. Today just-bash executes
 *     filesystem commands sequentially within a session, so callers do
 *     not issue concurrent IFileSystem operations against the same tree.
 *     WorkspaceManager's single-writer invariant is complementary: it
 *     prevents multiple sessions from acquiring the same sandbox, but it
 *     does not serialize operations inside one acquired session.
 */
export class DiskWorkingTree implements IFileSystem {
  readonly root: string;

  constructor(opts: DiskWorkingTreeOptions) {
    this.root = resolveRoot(opts.root);
  }

  // ---------------------------------------------------------------------
  // Path resolution
  //
  // Every public method MUST go through `resolve(virtualPath)` to
  // obtain the corresponding on-disk path. resolve() rejects anything
  // that would escape, including paths whose intermediate components
  // are symlinks.
  // ---------------------------------------------------------------------

  /**
   * Translate a virtual path to a real disk path, refusing to follow
   * any symlinks encountered on the way.
   *
   * `mustExist: true` requires the leaf to exist and not be a symlink.
   * `mustExist: false` allows the leaf to be absent (e.g. for writeFile
   * of a new file, or mkdir of a new directory). Intermediate path
   * components are allowed to be absent too (so mkdir({recursive:true})
   * and writeFile of a new nested file work). But ANY intermediate
   * that exists must be a real directory, never a symlink.
   */
  private async resolve(
    virtualPath: string,
    opts: {
      mustExist: boolean;
    },
  ): Promise<string> {
    const v = normalizeVirtualPath(virtualPath);
    if (v === null) throw makeEnoent(virtualPath);
    const real = joinToRoot(this.root, v);

    if (v === "/") return real;

    const rel = v.slice(1);
    const segments = rel.split("/");
    let current = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      current = current + sep + segments[i];
      let st: fs.Stats | null;
      try {
        st = await fsp.lstat(current);
      } catch {
        // Intermediate doesn't exist. If the caller is going to create
        // it (mustExist: false, e.g. writeFile or mkdir-recursive),
        // we can return early — the rest of the path is unknown but
        // the caller will materialize it. If the caller needs the path
        // to exist (mustExist: true, e.g. readFile or stat), throw.
        if (opts.mustExist) throw makeEnoent(virtualPath);
        return real;
      }
      if (st.isSymbolicLink()) throw makeEnoent(virtualPath);
      if (!st.isDirectory()) throw makeEnoent(virtualPath);
    }
    // Last segment: if it exists, it must not be a symlink.
    // If mustExist is true, it must exist at all.
    const leaf = current + sep + segments[segments.length - 1];
    let leafSt: fs.Stats | null = null;
    try {
      leafSt = await fsp.lstat(leaf);
    } catch {
      if (opts.mustExist) throw makeEnoent(virtualPath);
    }
    if (leafSt && leafSt.isSymbolicLink()) {
      throw makeEnoent(virtualPath);
    }
    return leaf;
  }

  /**
   * Same as resolve but only validates the parent chain; the leaf is
   * permitted to be a symlink (e.g. for readlink, lstat, rm).
   * Intermediate components may not exist yet (but if they do, they
   * must be real directories, never symlinks).
   */
  private async resolveAllowLeafSymlink(virtualPath: string): Promise<string> {
    const v = normalizeVirtualPath(virtualPath);
    if (v === null) throw makeEnoent(virtualPath);
    const real = joinToRoot(this.root, v);
    if (v === "/") return real;

    const rel = v.slice(1);
    const segments = rel.split("/");
    let current = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      current = current + sep + segments[i];
      let st: fs.Stats;
      try {
        st = await fsp.lstat(current);
      } catch {
        return real;
      }
      if (st.isSymbolicLink()) throw makeEnoent(virtualPath);
      if (!st.isDirectory()) throw makeEnoent(virtualPath);
    }
    return current + sep + segments[segments.length - 1];
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const real = await this.resolve(path, { mustExist: true });
    const encoding = typeof options === "string" ? options : (options?.encoding ?? "utf8");
    const buf = await fsp.readFile(real);
    return buf.toString(encoding as BufferEncoding);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const real = await this.resolve(path, { mustExist: true });
    return fsp.readFile(real);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.resolve(path, { mustExist: true });
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    const real = await this.resolve(path, { mustExist: true });
    const st = await fsp.stat(real);
    return statToFsStat(st);
  }

  async lstat(path: string): Promise<FsStat> {
    const real = await this.resolveAllowLeafSymlink(path);
    let st: fs.Stats;
    try {
      st = await fsp.lstat(real);
    } catch {
      throw makeEnoent(path);
    }
    return statToFsStat(st);
  }

  async readdir(path: string): Promise<string[]> {
    const real = await this.resolve(path, { mustExist: true });
    return fsp.readdir(real);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const real = await this.resolve(path, { mustExist: true });
    const entries = await fsp.readdir(real, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
      isSymbolicLink: e.isSymbolicLink(),
    }));
  }

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const real = await this.resolve(path, { mustExist: false });
    // Auto-create parent dirs to match InMemoryFs behavior
    await fsp.mkdir(dirname(real), { recursive: true });
    if (typeof content === "string") {
      const encoding = typeof options === "string" ? options : (options?.encoding ?? "utf8");
      await fsp.writeFile(real, content, encoding as BufferEncoding);
    } else {
      await fsp.writeFile(real, content);
    }
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const real = await this.resolve(path, { mustExist: false });
    await fsp.mkdir(dirname(real), { recursive: true });
    if (typeof content === "string") {
      const encoding = typeof options === "string" ? options : (options?.encoding ?? "utf8");
      await fsp.appendFile(real, content, encoding as BufferEncoding);
    } else {
      await fsp.appendFile(real, content);
    }
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const real = await this.resolve(path, { mustExist: false });
    await fsp.mkdir(real, { recursive: options?.recursive ?? false });
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    let real: string;
    try {
      real = await this.resolveAllowLeafSymlink(path);
    } catch (e) {
      if (options?.force) return;
      throw e;
    }
    try {
      await fsp.rm(real, {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      });
    } catch (e) {
      if (options?.force) return;
      throw e;
    }
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcReal = await this.resolve(src, { mustExist: true });
    const destReal = await this.resolve(dest, { mustExist: false });
    await fsp.mkdir(dirname(destReal), { recursive: true });
    await fsp.cp(srcReal, destReal, {
      recursive: options?.recursive ?? false,
      // Never follow symlinks when copying — we'd lose the protection
      dereference: false,
      // Preserve relative symlink targets byte-for-byte. Symlink
      // traversal still fails through resolve(), and symlink creation
      // already validates that targets stay inside the sandbox.
      verbatimSymlinks: true,
    });
  }

  async mv(src: string, dest: string): Promise<void> {
    const srcReal = await this.resolve(src, { mustExist: true });
    const destReal = await this.resolve(dest, { mustExist: false });
    await fsp.mkdir(dirname(destReal), { recursive: true });
    await fsp.rename(srcReal, destReal);
  }

  // ---------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------

  async chmod(path: string, mode: number): Promise<void> {
    const real = await this.resolve(path, { mustExist: true });
    await fsp.chmod(real, mode);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const real = await this.resolve(path, { mustExist: true });
    await fsp.utimes(real, atime, mtime);
  }

  // ---------------------------------------------------------------------
  // Symlinks
  //
  // We allow creating symlinks, but only with RELATIVE targets that,
  // when lexically resolved relative to the link's parent directory,
  // stay inside the sandbox root. Absolute targets are rejected. This
  // lets agents create things like 'ln -s ../shared/lib' but not
  // 'ln -s /etc/passwd'.
  //
  // Reads through symlinks (open, stat, etc.) still fail — resolve()
  // refuses to traverse symlinks. So symlinks created here are inert
  // for IFileSystem reads. They exist on disk for tools that lstat
  // them or readlink them explicitly, but you can't 'cat' through one.
  //
  // This is intentionally conservative for v1. We can relax later if
  // we add a safe symlink-follow path that re-validates every link
  // target against the root.
  // ---------------------------------------------------------------------

  async symlink(target: string, linkPath: string): Promise<void> {
    // Reject absolute targets outright.
    if (target.startsWith("/")) throw makeEnoent(linkPath);
    if (target.includes("\0")) throw makeEnoent(linkPath);

    const linkV = normalizeVirtualPath(linkPath);
    if (linkV === null || linkV === "/") throw makeEnoent(linkPath);
    const linkReal = await this.resolve(linkPath, { mustExist: false });

    // Verify the target, interpreted relative to the link's parent,
    // stays inside the sandbox. We walk the target's segments and
    // track depth manually — we can't use posix.normalize because it
    // collapses '..' past root silently.
    const parentV = posix.dirname(linkV);
    const parentDepth = parentV === "/" ? 0 : parentV.split("/").filter(Boolean).length;
    let depth = parentDepth;
    for (const seg of target.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        depth--;
        if (depth < 0) throw makeEnoent(linkPath); // escapes root
      } else {
        depth++;
      }
    }
    // depth >= 0 here means the target resolves inside the sandbox.

    await fsp.symlink(target, linkReal);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const existingReal = await this.resolve(existingPath, { mustExist: true });
    const newReal = await this.resolve(newPath, { mustExist: false });
    await fsp.mkdir(dirname(newReal), { recursive: true });
    await fsp.link(existingReal, newReal);
  }

  async readlink(path: string): Promise<string> {
    const real = await this.resolveAllowLeafSymlink(path);
    let st: fs.Stats;
    try {
      st = await fsp.lstat(real);
    } catch {
      throw makeEnoent(path);
    }
    if (!st.isSymbolicLink()) throw makeEnoent(path);
    return fsp.readlink(real);
  }

  async realpath(path: string): Promise<string> {
    // We never follow symlinks. Realpath returns the virtual path
    // after normalization. (If the path doesn't exist, we throw.)
    await this.resolve(path, { mustExist: true });
    return normalizeVirtualPath(path) ?? path;
  }

  // ---------------------------------------------------------------------
  // Path operations
  // ---------------------------------------------------------------------

  resolvePath(base: string, path: string): string {
    // Sandbox-relative resolution; no disk access.
    if (path.startsWith("/")) return normalizeVirtualPath(path) ?? path;
    const baseN = normalizeVirtualPath(base) ?? "/";
    return normalizeVirtualPath(posix.join(baseN, path)) ?? "/";
  }

  /**
   * Walks the entire tree synchronously and returns virtual paths.
   * Used by SizeLimitedFs.recalculate() and similar bookkeeping.
   */
  getAllPaths(): string[] {
    const result: string[] = [];
    const walk = (real: string, virtualPath: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(real, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const childReal = real + sep + e.name;
        const childVirtual = virtualPath === "/" ? `/${e.name}` : `${virtualPath}/${e.name}`;
        if (e.isSymbolicLink()) {
          // Include symlinks themselves but don't follow them.
          result.push(childVirtual);
          continue;
        }
        result.push(childVirtual);
        if (e.isDirectory()) walk(childReal, childVirtual);
      }
    };
    walk(this.root, "/");
    return result;
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /**
   * Remove everything inside the root, leaving the root itself.
   * Used by PersistentFs.boot() to start fresh before a restore.
   *
   * Fast path: when there's nothing weird in the tree, this is a
   * recursive rm of every immediate child of the root. Symlinks are
   * deleted as-is (we use lstat / no-follow rm).
   */
  async clear(): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map((e) => fsp.rm(this.root + sep + e.name, { recursive: true, force: true })),
    );
  }
}

function statToFsStat(st: fs.Stats): FsStat {
  return {
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    isSymbolicLink: st.isSymbolicLink(),
    mode: st.mode,
    size: st.size,
    mtime: st.mtime,
  };
}
