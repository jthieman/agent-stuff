import { sep } from "node:path";
import { realpathSync } from "node:fs";

/**
 * Errors thrown when an operation would escape the sandbox root.
 *
 * These are agent-facing — they look like ordinary ENOENT/EACCES to
 * callers, so an agent (or a buggy command) trying to escape sees
 * "file not found" rather than learning that escape detection exists.
 *
 * The Cause object is kept for harness debugging via .cause.
 */
export function makeEnoent(virtualPath: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, '${virtualPath}'`);
  e.code = "ENOENT";
  return e;
}

/**
 * Normalize a virtual (sandbox-relative) path into a clean form:
 *   - Always begins with '/'
 *   - No trailing '/' (except for the root itself)
 *   - No '.' segments
 *   - No empty segments (//)
 *   - REJECTS any '..' segments — does not collapse them
 *
 * Rejection (rather than collapse) is intentional: an agent that asks
 * for '/foo/../bar' is either confused or probing. Either way, the
 * answer is ENOENT.
 *
 * Returns null if the path is invalid (escape attempt, contains null
 * bytes, etc.).
 */
export function normalizeVirtualPath(input: string): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  if (input.includes("\0")) return null;

  // Windows-style separators are not virtual paths in our model.
  if (input.includes("\\")) return null;

  // Anchor: relative paths are interpreted relative to root.
  const anchored = input.startsWith("/") ? input : "/" + input;

  const segments = anchored.split("/");
  const clean: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null; // explicit escape attempt
    clean.push(seg);
  }
  return clean.length === 0 ? "/" : "/" + clean.join("/");
}

/**
 * Join a normalized virtual path onto the real on-disk root.
 *
 * The root must itself be a fully-resolved real path (no symlinks in
 * the prefix). Caller is expected to have called realpathSync on it.
 *
 * Throws if the result would not be lexically inside the root. This is
 * a belt-and-suspenders check after normalizeVirtualPath already
 * rejected '..'.
 */
export function joinToRoot(rootReal: string, virtualPath: string): string {
  // virtualPath is "/foo/bar"; we want "<root>/foo/bar"
  const rel = virtualPath === "/" ? "" : virtualPath.slice(1);
  const joined = rel === "" ? rootReal : rootReal + sep + rel.split("/").join(sep);

  // Lexical check: must be exactly the root, or start with root + sep.
  if (joined !== rootReal && !joined.startsWith(rootReal + sep)) {
    throw makeEnoent(virtualPath);
  }
  return joined;
}

/**
 * Resolve the real path of `root`, following any symlinks once at
 * construction time. After this, the returned root is symlink-free
 * and stable for lexical comparison.
 *
 * Throws if the root doesn't exist or isn't accessible.
 */
export function resolveRoot(root: string): string {
  return realpathSync(root);
}
