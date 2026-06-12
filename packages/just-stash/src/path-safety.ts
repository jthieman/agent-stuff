import { posix } from "node:path";

/**
 * Validate an archive entry path against the extraction root.
 *
 * Rejects:
 *   - Absolute paths inside the archive
 *   - `..` segments
 *   - Null bytes
 *   - Resolved paths that escape the root
 */
export function resolveArchiveEntryPath(root: string, entryName: string): string | null {
  if (!entryName || entryName === "." || entryName === "./") return null;
  if (entryName.includes("\0")) return null;
  if (entryName.startsWith("/")) return null;

  const cleaned = entryName.endsWith("/") ? entryName.slice(0, -1) : entryName;
  if (cleaned.split("/").some((s) => s === "..")) return null;

  const resolved = posix.normalize(posix.join(root, cleaned));
  const rootNorm = posix.normalize(root);
  const prefix = rootNorm === "/" ? "/" : rootNorm + "/";
  if (resolved !== rootNorm && !resolved.startsWith(prefix)) return null;

  return resolved;
}

/** Allow only files and directories — no symlinks, devices, etc. */
export function isSafeEntryType(type: string | null | undefined): boolean {
  return type === "file" || type === "directory";
}
