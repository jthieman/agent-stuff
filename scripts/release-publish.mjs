#!/usr/bin/env node
// Publishes workspace packages to npm using the npm CLI, which is the
// reference implementation for OIDC trusted publishing (short-lived,
// workflow-scoped credentials + automatic provenance). We use npm here rather
// than `pnpm publish` / `vp pm publish` because pnpm 11's OIDC path currently
// fails with a 404; when that regression is fixed you can switch to `pnpm -r publish`.
//
// This script is IDEMPOTENT: it publishes a package only if its current
// version is not already on the registry. Changesets has already bumped the
// versions of changed packages, so re-runs are safe.
//
// Requirements at runtime (provided by release.yml):
//   - npm >= 11.5.1, Node >= 22.14
//   - GitHub Actions with `id-token: write` (OIDC)
//   - Each package configured as a Trusted Publisher on npmjs.com
//   - Each package.json has publishConfig.access = "public" and provenance = true

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());

/** Minimal pnpm-workspace.yaml reader: pulls `dir/*` and `dir` globs. */
function workspaceGlobs() {
  const file = join(ROOT, "pnpm-workspace.yaml");
  if (!existsSync(file)) return ["packages/*"];
  const globs = [];
  let inPackages = false;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);
      if (m) globs.push(m[1]);
      else if (line.trim() && !/^\s/.test(raw)) break; // dedented -> section ended
    }
  }
  return globs.length ? globs : ["packages/*"];
}

/** Resolve simple globs (`dir/*` or a literal dir) into package directories. */
function packageDirs() {
  const dirs = new Set();
  for (const glob of workspaceGlobs()) {
    if (glob.endsWith("/*")) {
      const base = join(ROOT, glob.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base)) {
        const p = join(base, entry);
        if (statSync(p).isDirectory() && existsSync(join(p, "package.json"))) {
          dirs.add(p);
        }
      }
    } else {
      const p = join(ROOT, glob);
      if (existsSync(join(p, "package.json"))) dirs.add(p);
    }
  }
  return [...dirs];
}

/** Is name@version already on the registry? */
function alreadyPublished(name, version) {
  try {
    const out = execFileSync("npm", ["view", `${name}@${version}`, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === version;
  } catch {
    return false; // E404 (or first-ever publish) -> not published yet
  }
}

let publishedCount = 0;
let failed = false;

for (const dir of packageDirs()) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const { name, version, private: isPrivate } = pkg;

  if (isPrivate) continue;
  if (!name || !version) {
    console.warn(`skip: ${dir} has no name/version`);
    continue;
  }
  if (!name.startsWith("@jthieman/")) {
    console.warn(`skip: ${name} is outside the @jthieman scope`);
    continue;
  }
  if (alreadyPublished(name, version)) {
    console.log(`skip: ${name}@${version} already on registry`);
    continue;
  }

  console.log(`publish: ${name}@${version}`);
  try {
    // access + provenance come from each package's publishConfig, but we pass
    // --provenance explicitly as a belt-and-suspenders against the occasional
    // case where the default isn't applied.
    execFileSync("npm", ["publish", "--provenance", "--access", "public"], {
      cwd: dir,
      stdio: "inherit",
    });
    publishedCount++;
  } catch (err) {
    failed = true;
    console.error(`FAILED to publish ${name}@${version}: ${err.message}`);
  }
}

console.log(`\nDone. Published ${publishedCount} package(s).`);
if (failed) process.exit(1);
