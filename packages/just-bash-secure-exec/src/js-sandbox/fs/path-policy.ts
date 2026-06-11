import { posix } from "node:path";

import { JsSandboxRuntimeError } from "../runtime/normalize-error.ts";
import type { ResolvedSandboxPath } from "../types.ts";

export function normalizePosixPath(input: string): string {
  if (input.includes("\0")) {
    throw new JsSandboxRuntimeError("PERMISSION_DENIED", "Path contains a null byte");
  }

  const normalized = posix.normalize(input);
  if (normalized === ".") {
    return "/";
  }

  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }

  return normalized;
}

export function resolveSandboxPath(
  inputPath: string,
  options: {
    cwd: string;
    roots: string[];
    allowRelative: boolean;
  },
): ResolvedSandboxPath {
  if (!inputPath.startsWith("/") && !options.allowRelative) {
    throw new JsSandboxRuntimeError(
      "FS_PATH_OUTSIDE_ROOT",
      `Relative paths are not allowed: ${inputPath}`,
    );
  }

  const rawAbsolute = inputPath.startsWith("/") ? inputPath : posix.join(options.cwd, inputPath);
  const absolute = normalizePosixPath(rawAbsolute);

  for (const root of options.roots.map(normalizePosixPath)) {
    if (root === "/" || absolute === root || absolute.startsWith(`${root}/`)) {
      return { input: inputPath, absolute, root };
    }
  }

  throw new JsSandboxRuntimeError(
    "FS_PATH_OUTSIDE_ROOT",
    `Path is outside allowed roots: ${inputPath}`,
  );
}
