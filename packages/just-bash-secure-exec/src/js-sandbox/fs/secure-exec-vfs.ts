import { Buffer } from "node:buffer";
import { posix } from "node:path";

import type { FsStat, IFileSystem } from "just-bash";
import type { VirtualFileSystem } from "secure-exec";

import type { AuditRecorder } from "../audit/audit-recorder.ts";
import { JsSandboxRuntimeError } from "../runtime/normalize-error.ts";
import type { RuntimePolicy } from "../types.ts";
import { normalizePosixPath, resolveSandboxPath } from "./path-policy.ts";

const now = () => Date.now();

type VirtualDirEntry = Awaited<ReturnType<VirtualFileSystem["readDirWithTypes"]>>[number];
type VirtualStat = Awaited<ReturnType<VirtualFileSystem["stat"]>>;

export class SecureExecJustBashFileSystem implements VirtualFileSystem {
  constructor(
    private readonly fs: IFileSystem,
    private readonly audit: AuditRecorder,
    private readonly cwd: string,
    private readonly policy: RuntimePolicy,
    private readonly virtualFiles = new Map<string, Uint8Array>(),
  ) {}

  addVirtualFile(path: string, content: string | Uint8Array): void {
    this.virtualFiles.set(
      normalizePosixPath(path),
      typeof content === "string" ? new TextEncoder().encode(content) : content,
    );
  }

  async readFile(path: string): Promise<Uint8Array> {
    const normalized = normalizePosixPath(path);
    const virtualFile = this.virtualFiles.get(normalized);
    if (virtualFile !== undefined) {
      this.auditModuleIfApplicable(normalized);
      return new Uint8Array(virtualFile);
    }

    const resolved = await this.resolveExistingPath(path, "read", "read");
    await this.assertExistingFileWithinLimit(resolved, "read");
    this.audit.fsRead(resolved);
    this.auditModuleIfApplicable(resolved);
    return await this.fs.readFileBuffer(resolved);
  }

  async readTextFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path));
  }

  async readDir(path: string): Promise<string[]> {
    const resolved = await this.resolveExistingPath(path, "readdir", "read");
    this.audit.fsRead(resolved);
    const names = new Set(await this.fs.readdir(resolved));

    for (const virtualPath of this.virtualFiles.keys()) {
      if (posix.dirname(virtualPath) === resolved) {
        names.add(posix.basename(virtualPath));
      }
    }

    return [...names].sort();
  }

  async readDirWithTypes(path: string): Promise<VirtualDirEntry[]> {
    const normalized = normalizePosixPath(path);
    const names = await this.readDir(normalized);
    return await Promise.all(
      names.map(async (name) => {
        const childPath = posix.join(normalized, name);
        const stat = await this.lstat(childPath);
        return {
          name,
          isDirectory: stat.isDirectory,
          isSymbolicLink: stat.isSymbolicLink,
        };
      }),
    );
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const resolved = await this.resolveWriteTargetPath(path, "write", "write");
    this.assertFileSize(resolved, byteLength(content), "write");
    this.audit.fsWrite(resolved);
    await this.fs.writeFile(resolved, content);
  }

  async createDir(path: string): Promise<void> {
    const resolved = await this.resolveDirectoryEntryPath(path, "createDir", "mkdir");
    this.audit.fsWrite(resolved);
    await this.fs.mkdir(resolved);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const resolved = await this.resolveDirectoryEntryPath(path, "mkdir", "mkdir");
    this.audit.fsWrite(resolved);
    await this.fs.mkdir(resolved, options);
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePosixPath(path);
    if (this.virtualFiles.has(normalized)) {
      return true;
    }

    const resolved = this.resolveFsPath(path, "exists", "read");
    if (!(await this.fs.exists(resolved))) {
      return false;
    }

    const realPath = await this.resolveExistingPath(path, "exists", "read");
    this.audit.fsRead(realPath);
    return true;
  }

  async stat(path: string): Promise<VirtualStat> {
    const normalized = normalizePosixPath(path);
    const virtualFile = this.virtualFiles.get(normalized);
    if (virtualFile !== undefined) {
      return virtualStat({
        isDirectory: false,
        isSymbolicLink: false,
        size: virtualFile.byteLength,
      });
    }

    const resolved = await this.resolveExistingPath(path, "stat", "read");
    this.audit.fsRead(resolved);
    const stat = await this.fs.stat(resolved);
    return virtualStat({
      isDirectory: stat.isDirectory,
      isSymbolicLink: stat.isSymbolicLink,
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtime.getTime(),
    });
  }

  async removeFile(path: string): Promise<void> {
    const resolved = await this.resolveDirectoryEntryPath(path, "rm", "delete");
    this.audit.fsDelete(resolved);
    await this.fs.rm(resolved);
  }

  async removeDir(path: string): Promise<void> {
    const resolved = await this.resolveDirectoryEntryPath(path, "rm", "delete");
    this.audit.fsDelete(resolved);
    await this.fs.rm(resolved, { recursive: false });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldResolved = await this.resolveDirectoryEntryPath(oldPath, "rename", "delete");
    const newResolved = await this.resolveDirectoryEntryPath(newPath, "rename", "write");
    this.audit.fsDelete(oldResolved);
    this.audit.fsWrite(newResolved);
    await this.fs.mv(oldResolved, newResolved);
  }

  async realpath(path: string): Promise<string> {
    const normalized = normalizePosixPath(path);
    if (this.virtualFiles.has(normalized)) {
      return normalized;
    }

    const resolved = await this.resolveExistingPath(path, "realpath", "read");
    this.audit.fsRead(resolved);
    return resolved;
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    this.denyUnsupportedFsOp("symlink", linkPath, "Symlinks are denied", "FS_WRITE_DENIED");
  }

  async readlink(path: string): Promise<string> {
    this.denyUnsupportedFsOp("readlink", path, "Symlinks are denied", "FS_READ_DENIED");
  }

  async lstat(path: string): Promise<VirtualStat> {
    const normalized = normalizePosixPath(path);
    const virtualFile = this.virtualFiles.get(normalized);
    if (virtualFile !== undefined) {
      return virtualStat({
        isDirectory: false,
        isSymbolicLink: false,
        size: virtualFile.byteLength,
      });
    }

    const resolved = await this.resolveDirectoryEntryPath(path, "lstat", "read");
    this.audit.fsRead(resolved);
    const stat = await this.fs.lstat(resolved);
    return virtualStat({
      isDirectory: stat.isDirectory,
      isSymbolicLink: stat.isSymbolicLink,
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtime.getTime(),
    });
  }

  async link(_oldPath: string, newPath: string): Promise<void> {
    this.denyUnsupportedFsOp("link", newPath, "Hard links are denied", "FS_WRITE_DENIED");
  }

  async chmod(path: string, mode: number): Promise<void> {
    const resolved = await this.resolveExistingPath(path, "chmod", "write");
    this.audit.fsWrite(resolved);
    await this.fs.chmod(resolved, mode);
  }

  async chown(path: string, _uid: number, _gid: number): Promise<void> {
    this.denyUnsupportedFsOp("chown", path, "chown is denied", "FS_WRITE_DENIED");
  }

  async utimes(path: string, atime: number, mtime: number): Promise<void> {
    const resolved = await this.resolveExistingPath(path, "utimes", "write");
    this.audit.fsWrite(resolved);
    await this.fs.utimes(resolved, new Date(atime), new Date(mtime));
  }

  async truncate(path: string, length: number): Promise<void> {
    const resolved = await this.resolveWriteTargetPath(path, "truncate", "write");
    this.assertByteCount(resolved, length, "truncate length", "truncate");
    this.assertFileSize(resolved, length, "truncate");
    await this.statFileForWrite(resolved, "truncate");
    const current = length === 0 ? new Uint8Array() : await this.readExistingFileForWrite(resolved);
    const next = new Uint8Array(length);
    next.set(current.subarray(0, Math.min(current.length, length)));
    this.audit.fsWrite(resolved);
    await this.fs.writeFile(resolved, next);
  }

  async pread(path: string, offset: number, length: number): Promise<Uint8Array> {
    const normalized = normalizePosixPath(path);
    this.assertByteCount(normalized, offset, "pread offset", "read");
    this.assertByteCount(normalized, length, "pread length", "read");
    const content = await this.readFile(path);
    return content.subarray(offset, offset + length);
  }

  async pwrite(path: string, offset: number, data: Uint8Array): Promise<void> {
    const resolved = await this.resolveWriteTargetPath(path, "write", "write");
    this.assertByteCount(resolved, offset, "pwrite offset", "write");
    this.assertFileSize(resolved, data.byteLength, "write");
    this.assertFileSize(resolved, offset + data.byteLength, "write");
    const stat = await this.tryStatFileForWrite(resolved, "write");
    const currentSize = stat?.size ?? 0;
    const nextSize = Math.max(currentSize, offset + data.byteLength);
    this.assertFileSize(resolved, nextSize, "write");
    const current =
      currentSize === 0 ? new Uint8Array() : await this.readExistingFileForWrite(resolved);
    const next = Buffer.alloc(nextSize);
    next.set(current);
    next.set(data, offset);
    this.audit.fsWrite(resolved);
    await this.fs.writeFile(resolved, next);
  }

  private resolveFsPath(
    path: string,
    op: string,
    capability: "read" | "write" | "mkdir" | "delete",
  ): string {
    if (this.policy.fs === false) {
      this.audit.deniedFsOp(op, normalizePosixPath(path), "filesystem disabled");
      throw new JsSandboxRuntimeError("FS_ACCESS_DENIED", "filesystem disabled");
    }

    let resolved;
    try {
      resolved = resolveSandboxPath(path, {
        cwd: this.cwd,
        roots: this.policy.fs.roots,
        allowRelative: true,
      }).absolute;
    } catch (error) {
      this.audit.deniedFsOp(op, normalizePosixPath(path), "path outside allowed roots");
      throw error;
    }

    if (!this.policy.fs[capability]) {
      const reason = capability === "delete" ? "delete disabled" : `${capability} disabled`;
      this.audit.deniedFsOp(op, resolved, reason);
      throw new JsSandboxRuntimeError("FS_ACCESS_DENIED", reason);
    }

    return resolved;
  }

  private async resolveExistingPath(
    path: string,
    op: string,
    capability: "read" | "write" | "mkdir" | "delete",
  ): Promise<string> {
    const resolved = this.resolveFsPath(path, op, capability);
    return await this.assertRealPathWithinRoots(resolved, op);
  }

  private async resolveWriteTargetPath(
    path: string,
    op: string,
    capability: "write" | "mkdir",
  ): Promise<string> {
    const resolved = this.resolveFsPath(path, op, capability);
    const lstat = await this.tryLstat(resolved);

    if (lstat?.isSymbolicLink) {
      const realPath = await this.tryRealpath(resolved);
      if (realPath !== undefined) {
        return this.assertPathWithinRoots(realPath, resolved, op);
      }

      const targetPath = await this.resolveSymlinkTargetPath(resolved);
      const target = this.resolveFsPath(targetPath, op, capability);
      return await this.resolveDirectoryEntryPathFromResolved(target, op);
    }

    if (lstat !== undefined) {
      return await this.assertRealPathWithinRoots(resolved, op);
    }

    return await this.resolveDirectoryEntryPathFromResolved(resolved, op);
  }

  private async resolveDirectoryEntryPath(
    path: string,
    op: string,
    capability: "read" | "write" | "mkdir" | "delete",
  ): Promise<string> {
    const resolved = this.resolveFsPath(path, op, capability);
    return await this.resolveDirectoryEntryPathFromResolved(resolved, op);
  }

  private async resolveDirectoryEntryPathFromResolved(
    resolved: string,
    op: string,
  ): Promise<string> {
    if (this.isConfiguredRoot(resolved)) {
      return resolved;
    }

    const parent = posix.dirname(resolved);
    if (parent === resolved) {
      return resolved;
    }

    const realParent = await this.assertRealPathWithinRoots(parent, op);
    return posix.join(realParent, posix.basename(resolved));
  }

  private async assertRealPathWithinRoots(path: string, op: string): Promise<string> {
    const realPath = await this.fs.realpath(path);
    return this.assertPathWithinRoots(realPath, path, op);
  }

  private assertPathWithinRoots(path: string, auditPath: string, op: string): string {
    const normalized = normalizePosixPath(path);
    if (this.pathIsWithinRoots(normalized)) {
      return normalized;
    }

    const reason = "path outside allowed roots after symlink resolution";
    this.audit.deniedFsOp(op, auditPath, reason);
    throw new JsSandboxRuntimeError("FS_PATH_OUTSIDE_ROOT", reason);
  }

  private async resolveSymlinkTargetPath(linkPath: string): Promise<string> {
    const target = await this.fs.readlink(linkPath);
    return normalizePosixPath(
      target.startsWith("/") ? target : posix.join(posix.dirname(linkPath), target),
    );
  }

  private async tryLstat(
    path: string,
  ): Promise<Awaited<ReturnType<IFileSystem["lstat"]>> | undefined> {
    try {
      return await this.fs.lstat(path);
    } catch {
      return undefined;
    }
  }

  private async tryRealpath(path: string): Promise<string | undefined> {
    try {
      return await this.fs.realpath(path);
    } catch {
      return undefined;
    }
  }

  private pathIsWithinRoots(path: string): boolean {
    if (this.policy.fs === false) {
      return false;
    }

    return this.policy.fs.roots.map(normalizePosixPath).some((root) => {
      return root === "/" || path === root || path.startsWith(`${root}/`);
    });
  }

  private isConfiguredRoot(path: string): boolean {
    return this.policy.fs !== false && this.policy.fs.roots.map(normalizePosixPath).includes(path);
  }

  private denyUnsupportedFsOp(op: string, path: string, reason: string, code: string): never {
    const auditPath = normalizePosixPath(path.startsWith("/") ? path : posix.join(this.cwd, path));
    this.audit.deniedFsOp(op, auditPath, reason);
    throw new JsSandboxRuntimeError(code, reason);
  }

  private async readExistingFileForWrite(path: string): Promise<Uint8Array> {
    return await this.fs.readFileBuffer(path);
  }

  private async tryStatFileForWrite(path: string, op: string): Promise<FsStat | undefined> {
    try {
      return await this.statFileForWrite(path, op);
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }

      throw error;
    }
  }

  private async statFileForWrite(path: string, op: string): Promise<FsStat> {
    const stat = await this.fs.stat(path);
    if (stat.isFile) {
      return stat;
    }

    const reason = "target must be a file";
    this.audit.deniedFsOp(op, path, reason);
    throw new JsSandboxRuntimeError("FS_WRITE_DENIED", reason);
  }

  private auditModuleIfApplicable(path: string): void {
    if (/\.(?:cjs|mjs|js)$/.test(path)) {
      this.audit.moduleLoaded(path);
    }
  }

  private async assertExistingFileWithinLimit(path: string, op: string): Promise<void> {
    const stat = await this.fs.stat(path);
    if (stat.isFile) {
      this.assertFileSize(path, stat.size, op);
    }
  }

  private assertByteCount(path: string, value: number, label: string, op: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      this.audit.deniedFsOp(op, path, `${label} must be a nonnegative safe integer`);
      throw new JsSandboxRuntimeError(
        "INVALID_FS_SIZE",
        `${label} must be a nonnegative safe integer`,
      );
    }
  }

  private assertFileSize(path: string, size: number, op: string): void {
    this.assertByteCount(path, size, "file size", op);
    if (size <= this.policy.maxFileBytes) {
      return;
    }

    const reason = `file size limit exceeded (${size} bytes, max ${this.policy.maxFileBytes})`;
    this.audit.deniedFsOp(op, path, reason);
    throw new JsSandboxRuntimeError("FILE_SIZE_LIMIT", reason);
  }
}

function byteLength(content: string | Uint8Array): number {
  return typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && /ENOENT|no such file or directory/i.test(error.message);
}

function virtualStat(options: {
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode?: number;
  size: number;
  mtimeMs?: number;
}): VirtualStat {
  const timestamp = options.mtimeMs ?? now();
  return {
    mode: options.mode ?? (options.isDirectory ? 0o040755 : 0o100644),
    size: options.size,
    isDirectory: options.isDirectory,
    isSymbolicLink: options.isSymbolicLink,
    atimeMs: timestamp,
    mtimeMs: timestamp,
    ctimeMs: timestamp,
    birthtimeMs: timestamp,
    ino: 0,
    nlink: 1,
    uid: 0,
    gid: 0,
  };
}
