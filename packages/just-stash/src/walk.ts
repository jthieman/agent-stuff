import type { IFileSystem } from "just-bash";
import type { DirentEntry } from "./just-bash-types.ts";

/**
 * Normalized exclude-prefix path. Always absolute, never trailing slash.
 *
 *   normalizeExcludePath('/scratch')      → '/scratch'
 *   normalizeExcludePath('/scratch/')     → '/scratch'
 *   normalizeExcludePath('scratch')       → '/scratch'
 */
export function normalizeExcludePath(p: string): string {
  let s = p.startsWith("/") ? p : "/" + p;
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/**
 * True if `path` should be excluded from a snapshot, given exclude prefixes.
 *
 * Exclusion is prefix-match on the virtual path. `'/scratch'` excludes
 * `/scratch` itself and everything under it.
 */
export function isExcludedFromSnapshot(path: string, excludePrefixes: string[]): boolean {
  for (const prefix of excludePrefixes) {
    if (path === prefix) return true;
    if (path.startsWith(prefix + "/")) return true;
  }
  return false;
}

/**
 * Visit every (file or directory) path under `root`, skipping excluded
 * subtrees, calling `visit` for each.
 *
 * Skips symlinks (they don't go in snapshots).
 *
 * Walks depth-first. For each directory, the visitor is called BEFORE
 * the children. For files, isDirectory will be false.
 */
export async function walkSnapshot(
  fs: IFileSystem,
  root: string,
  excludePrefixes: string[],
  visit: (entry: {
    path: string;
    name: string;
    isFile: boolean;
    isDirectory: boolean;
  }) => Promise<void>,
): Promise<void> {
  async function walk(currentPath: string): Promise<void> {
    let entries: DirentEntry[] = fs.readdirWithFileTypes
      ? await fs.readdirWithFileTypes(currentPath)
      : await readdirWithStatFallback(fs, currentPath);
    // Sort lexically by name. POSIX doesn't guarantee readdir order,
    // and filesystem implementations vary (ext4 uses hash order for
    // large dirs; XFS uses block order; NFS forwards server order).
    // Snapshot byte-determinism requires we impose an order ourselves.
    entries = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const childPath = currentPath === "/" ? `/${entry.name}` : `${currentPath}/${entry.name}`;
      if (isExcludedFromSnapshot(childPath, excludePrefixes)) continue;
      if (entry.isSymbolicLink) continue;

      if (entry.isDirectory) {
        await visit({
          path: childPath,
          name: entry.name,
          isFile: false,
          isDirectory: true,
        });
        await walk(childPath);
      } else if (entry.isFile) {
        await visit({
          path: childPath,
          name: entry.name,
          isFile: true,
          isDirectory: false,
        });
      }
    }
  }

  // Confirm root exists and is a directory. Snapshot callers treat this
  // walk as authoritative, so read errors must abort the commit.
  const st = fs.lstat ? await fs.lstat(root) : await fs.stat(root);
  if (!st.isDirectory) return;
  await walk(root);
}

/**
 * Delete everything under `root` (but not `root` itself). Used by
 * PersistentFs.boot() before restoring from a snapshot.
 *
 * Walks via the IFileSystem only — no host fs access.
 */
export async function clearFsContents(fs: IFileSystem, root: string = "/"): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return;
  }

  for (const name of entries) {
    const childPath = root === "/" ? `/${name}` : `${root}/${name}`;
    try {
      await fs.rm(childPath, { recursive: true, force: true });
    } catch {
      // best effort; some filesystems may refuse certain deletes
    }
  }
}

async function readdirWithStatFallback(fs: IFileSystem, path: string): Promise<DirentEntry[]> {
  const names = await fs.readdir(path);
  const prefix = path.endsWith("/") ? path : path + "/";
  const result: DirentEntry[] = [];
  for (const name of names) {
    const st = fs.lstat ? await fs.lstat(prefix + name) : await fs.stat(prefix + name);
    result.push({
      name,
      isFile: st.isFile,
      isDirectory: st.isDirectory,
      isSymbolicLink: st.isSymbolicLink,
    });
  }
  return result;
}
