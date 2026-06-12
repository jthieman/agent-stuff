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

export interface SizeLimitedFsOptions {
  maxBytes: number;
  /** Default 10_000. */
  maxEntries?: number;
}

/**
 * Wraps any IFileSystem with byte and entry-count limits.
 *
 * Throws ENOSPC when a write would exceed either limit. Tracks counters
 * via every write; call recalculate() after restoring from a snapshot
 * to reset from the inner fs state.
 */
export class SizeLimitedFs implements IFileSystem {
  private _totalBytes = 0;
  private _totalEntries = 0;
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  constructor(
    private readonly inner: IFileSystem,
    opts: SizeLimitedFsOptions,
  ) {
    this.maxBytes = opts.maxBytes;
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  get totalBytes(): number {
    return this._totalBytes;
  }
  get totalEntries(): number {
    return this._totalEntries;
  }

  private checkEntryLimit(addEntries: number, path: string): void {
    if (this._totalEntries + addEntries > this.maxEntries) {
      const err: NodeJS.ErrnoException = new Error(
        `ENOSPC: workspace entry limit exceeded (${this._totalEntries + addEntries} > ${this.maxEntries}): ${path}`,
      );
      err.code = "ENOSPC";
      throw err;
    }
  }

  private checkByteLimit(addBytes: number, path: string): void {
    if (this._totalBytes + addBytes > this.maxBytes) {
      const err: NodeJS.ErrnoException = new Error(
        `ENOSPC: workspace size limit exceeded (${this._totalBytes + addBytes} > ${this.maxBytes} bytes): ${path}`,
      );
      err.code = "ENOSPC";
      throw err;
    }
  }

  private byteLength(content: FileContent): number {
    return typeof content === "string"
      ? new TextEncoder().encode(content).byteLength
      : content.byteLength;
  }

  // --- Writes with tracking ---

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const newBytes = this.byteLength(content);
    let existingBytes = 0;
    const isNew = !(await this.inner.exists(path));
    try {
      const st = await this.inner.stat(path);
      if (!st.isDirectory) {
        existingBytes = st.size;
      }
    } catch {
      /* doesn't exist */
    }

    const addEntries = isNew ? await this.countMissingPathEntries(path, true) : 0;
    if (addEntries > 0) this.checkEntryLimit(addEntries, path);
    const delta = newBytes - existingBytes;
    if (delta > 0) this.checkByteLimit(delta, path);

    await this.inner.writeFile(path, content, options);
    this._totalBytes += delta;
    this._totalEntries += addEntries;
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const addBytes = this.byteLength(content);
    const isNew = !(await this.inner.exists(path));
    const addEntries = isNew ? await this.countMissingPathEntries(path, true) : 0;

    if (addEntries > 0) this.checkEntryLimit(addEntries, path);
    this.checkByteLimit(addBytes, path);

    await this.inner.appendFile(path, content, options);
    this._totalBytes += addBytes;
    this._totalEntries += addEntries;
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const addEntries = options?.recursive
      ? await this.countMissingPathEntries(path, true)
      : (await this.inner.exists(path))
        ? 0
        : 1;
    if (addEntries > 0) this.checkEntryLimit(addEntries, path);
    await this.inner.mkdir(path, options);
    this._totalEntries += addEntries;
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const stats = await this.measureExistingTreeIfPresent(path);
    await this.inner.rm(path, options);
    if (stats) {
      this._totalBytes = Math.max(0, this._totalBytes - stats.bytes);
      this._totalEntries = Math.max(0, this._totalEntries - stats.entries);
    }
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const sourceStats = await this.measureExistingTree(src);
    const destStats = (await this.inner.exists(dest))
      ? await this.measureExistingTree(dest)
      : { bytes: 0, entries: 0 };
    const addEntries =
      (await this.countMissingPathEntries(dest, false)) +
      Math.max(0, sourceStats.entries - destStats.entries);
    const addBytes = Math.max(0, sourceStats.bytes - destStats.bytes);

    if (addEntries > 0) this.checkEntryLimit(addEntries, dest);
    if (addBytes > 0) this.checkByteLimit(addBytes, dest);

    await this.inner.cp(src, dest, options);
    this._totalBytes += addBytes;
    this._totalEntries += addEntries;
  }

  async mv(src: string, dest: string): Promise<void> {
    const destStats = (await this.inner.exists(dest))
      ? await this.measureExistingTree(dest)
      : { bytes: 0, entries: 0 };
    const addEntries = await this.countMissingPathEntries(dest, false);
    const entryDelta = addEntries - destStats.entries;
    if (entryDelta > 0) this.checkEntryLimit(entryDelta, dest);
    await this.inner.mv(src, dest);
    this._totalBytes = Math.max(0, this._totalBytes - destStats.bytes);
    this._totalEntries = Math.max(0, this._totalEntries + entryDelta);
  }

  // --- Passthrough ---

  readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    return this.inner.readFile(path, options);
  }
  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.inner.readFileBuffer(path);
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
  readdir(path: string): Promise<string[]> {
    return this.inner.readdir(path);
  }
  readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    if (!this.inner.readdirWithFileTypes)
      throw new Error("Inner fs does not support readdirWithFileTypes");
    return this.inner.readdirWithFileTypes(path);
  }
  resolvePath(base: string, path: string): string {
    return this.inner.resolvePath(base, path);
  }
  getAllPaths(): string[] {
    return this.inner.getAllPaths();
  }
  chmod(path: string, mode: number): Promise<void> {
    return this.inner.chmod(path, mode);
  }
  async symlink(target: string, linkPath: string): Promise<void> {
    const addEntries = await this.countMissingPathEntries(linkPath, true);
    if (addEntries > 0) this.checkEntryLimit(addEntries, linkPath);
    await this.inner.symlink(target, linkPath);
    this._totalEntries += addEntries;
  }
  async link(existingPath: string, newPath: string): Promise<void> {
    const addEntries = await this.countMissingPathEntries(newPath, true);
    if (addEntries > 0) this.checkEntryLimit(addEntries, newPath);
    await this.inner.link(existingPath, newPath);
    this._totalEntries += addEntries;
  }
  readlink(path: string): Promise<string> {
    return this.inner.readlink(path);
  }
  realpath(path: string): Promise<string> {
    return this.inner.realpath(path);
  }
  utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    return this.inner.utimes(path, atime, mtime);
  }

  // --- Recalculate ---

  /** Reset counters from the inner fs state. Call after restore. */
  async recalculate(): Promise<void> {
    const stats = await this.measureExistingTree("/");
    this._totalBytes = stats.bytes;
    this._totalEntries = stats.entries;
  }

  private async measureExistingTree(path: string): Promise<{ bytes: number; entries: number }> {
    const st = await this.inner.lstat(path);
    let bytes = st.isFile ? st.size : 0;
    let entries = path === "/" ? 0 : 1;
    if (st.isDirectory) {
      const names = await this.inner.readdir(path);
      const prefix = path.endsWith("/") ? path : path + "/";
      for (const name of names) {
        const child = await this.measureExistingTree(prefix + name);
        bytes += child.bytes;
        entries += child.entries;
      }
    }
    return { bytes, entries };
  }

  private async measureExistingTreeIfPresent(
    path: string,
  ): Promise<{ bytes: number; entries: number } | null> {
    try {
      return await this.measureExistingTree(path);
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
  }

  private async countMissingPathEntries(path: string, includeLeaf: boolean): Promise<number> {
    const parts = path.split("/").filter(Boolean);
    const limit = includeLeaf ? parts.length : Math.max(0, parts.length - 1);
    let count = 0;
    let current = "";
    for (let i = 0; i < limit; i++) {
      current += `/${parts[i]}`;
      if (!(await this.inner.exists(current))) count++;
    }
    return count;
  }
}
