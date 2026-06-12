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
import { isPathExcluded } from "../path-filter.ts";

export interface FilteredFsOptions {
  /**
   * Exclude patterns. Any path with a segment matching a pattern is hidden.
   *
   *   '.env'      — exact segment match
   *   '.env*'     — segment starts with '.env'
   *   '*.pem'     — segment ends with '.pem'
   *   '*secret*'  — segment contains 'secret'
   */
  exclude?: string[];

  /**
   * Custom filter function. Return `false` to hide a path. Applied in
   * addition to `exclude`.
   */
  filter?: (virtualPath: string) => boolean;
}

/**
 * Wraps any IFileSystem with exclude patterns and a custom filter.
 *
 * Excluded paths are genuinely invisible: readFile throws ENOENT,
 * exists returns false, readdir omits them, writeFile to an excluded
 * path is blocked. The filter is a security boundary, not a hint.
 */
export class FilteredFs implements IFileSystem {
  private readonly excludePatterns: string[];
  private readonly filterFn?: (path: string) => boolean;

  constructor(
    private readonly inner: IFileSystem,
    opts: FilteredFsOptions,
  ) {
    this.excludePatterns = opts.exclude ?? [];
    this.filterFn = opts.filter;
  }

  private isExcluded(path: string): boolean {
    return isPathExcluded(path, this.excludePatterns, this.filterFn);
  }

  private requireVisible(path: string): void {
    if (this.isExcluded(path)) {
      throw hiddenPathError(path);
    }
  }

  private async requireResolvedVisible(path: string): Promise<void> {
    this.requireVisible(path);
    let resolved: string;
    try {
      resolved = await this.inner.realpath(path);
    } catch (e: any) {
      if (e?.code === "ENOENT") return;
      throw e;
    }
    this.requireVisible(resolved);
  }

  private async isEffectivelyVisible(path: string): Promise<boolean> {
    if (this.isExcluded(path)) return false;
    try {
      await this.requireResolvedVisible(path);
      return true;
    } catch (e: any) {
      if (e?.code === "ENOENT") return false;
      throw e;
    }
  }

  private async requireWritablePath(path: string): Promise<void> {
    this.requireVisible(path);
    await this.requireVisibleExistingAncestors(path);
    if (await this.inner.exists(path)) {
      await this.requireResolvedVisible(path);
    }
  }

  private async requireVisibleExistingAncestors(path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < Math.max(0, parts.length - 1); i++) {
      current += `/${parts[i]}`;
      if (await this.inner.exists(current)) {
        await this.requireResolvedVisible(current);
      }
    }
  }

  private async requireVisibleSubtree(path: string): Promise<void> {
    await this.requireResolvedVisible(path);
    const st = await this.inner.lstat(path);
    if (!st.isDirectory) return;
    await this.requireVisibleDescendants(path);
  }

  private async requireVisibleDescendants(path: string): Promise<void> {
    const entries = await this.inner.readdir(path);
    const prefix = path.endsWith("/") ? path : path + "/";
    for (const name of entries) {
      const child = prefix + name;
      if (!(await this.isEffectivelyVisible(child))) {
        throw hiddenPathError(child);
      }
      const st = await this.inner.lstat(child);
      if (st.isDirectory) await this.requireVisibleDescendants(child);
    }
  }

  private resolveSymlinkTarget(target: string, linkPath: string): string {
    const base = parentOf(linkPath);
    return this.inner.resolvePath(base, target);
  }

  // --- Read ---

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    await this.requireResolvedVisible(path);
    return this.inner.readFile(path, options);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    await this.requireResolvedVisible(path);
    return this.inner.readFileBuffer(path);
  }

  async exists(path: string): Promise<boolean> {
    if (this.isExcluded(path)) return false;
    if (!(await this.inner.exists(path))) return false;
    return this.isEffectivelyVisible(path);
  }

  async stat(path: string): Promise<FsStat> {
    await this.requireResolvedVisible(path);
    return this.inner.stat(path);
  }

  async lstat(path: string): Promise<FsStat> {
    await this.requireResolvedVisible(path);
    return this.inner.lstat(path);
  }

  async readdir(path: string): Promise<string[]> {
    await this.requireResolvedVisible(path);
    const entries = await this.inner.readdir(path);
    const prefix = path.endsWith("/") ? path : path + "/";
    const visible: string[] = [];
    for (const name of entries) {
      if (await this.isEffectivelyVisible(prefix + name)) visible.push(name);
    }
    return visible;
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    await this.requireResolvedVisible(path);
    const prefix = path.endsWith("/") ? path : path + "/";
    if (!this.inner.readdirWithFileTypes) {
      const names = await this.readdir(path);
      const result: DirentEntry[] = [];
      for (const name of names) {
        const st = await this.inner.lstat(prefix + name);
        result.push({
          name,
          isFile: st.isFile,
          isDirectory: st.isDirectory,
          isSymbolicLink: st.isSymbolicLink,
        });
      }
      return result;
    }
    const entries = await this.inner.readdirWithFileTypes(path);
    const visible: DirentEntry[] = [];
    for (const entry of entries) {
      if (await this.isEffectivelyVisible(prefix + entry.name)) visible.push(entry);
    }
    return visible;
  }

  // --- Write ---

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    await this.requireWritablePath(path);
    return this.inner.writeFile(path, content, options);
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    await this.requireWritablePath(path);
    return this.inner.appendFile(path, content, options);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.requireVisible(path);
    await this.requireVisibleExistingAncestors(path);
    return this.inner.mkdir(path, options);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    if (!(await this.isEffectivelyVisible(path))) {
      if (options?.force) return;
      this.requireVisible(path);
      await this.requireResolvedVisible(path);
    }
    return this.inner.rm(path, options);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    await this.requireVisibleSubtree(src);
    await this.requireWritablePath(dest);
    return this.inner.cp(src, dest, options);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.requireVisibleSubtree(src);
    await this.requireWritablePath(dest);
    return this.inner.mv(src, dest);
  }

  // --- Metadata ---

  async chmod(path: string, mode: number): Promise<void> {
    await this.requireResolvedVisible(path);
    return this.inner.chmod(path, mode);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    await this.requireResolvedVisible(path);
    return this.inner.utimes(path, atime, mtime);
  }

  // --- Symlinks ---

  async symlink(target: string, linkPath: string): Promise<void> {
    this.requireVisible(linkPath);
    await this.requireVisibleExistingAncestors(linkPath);
    this.requireVisible(this.resolveSymlinkTarget(target, linkPath));
    return this.inner.symlink(target, linkPath);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await this.requireResolvedVisible(existingPath);
    await this.requireWritablePath(newPath);
    return this.inner.link(existingPath, newPath);
  }

  async readlink(path: string): Promise<string> {
    await this.requireResolvedVisible(path);
    return this.inner.readlink(path);
  }

  async realpath(path: string): Promise<string> {
    await this.requireResolvedVisible(path);
    const real = await this.inner.realpath(path);
    this.requireVisible(real);
    return real;
  }

  // --- Path ---

  resolvePath(base: string, path: string): string {
    return this.inner.resolvePath(base, path);
  }

  getAllPaths(): string[] {
    return this.inner.getAllPaths().filter((p) => !this.isExcluded(p));
  }
}

function hiddenPathError(path: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, '${path}'`);
  err.code = "ENOENT";
  return err;
}

function parentOf(path: string): string {
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}
