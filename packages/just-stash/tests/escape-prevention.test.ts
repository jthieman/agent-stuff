import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DiskWorkingTree } from "../src/disk/disk-working-tree.ts";

// These tests verify the security invariant: a caller using IFileSystem
// methods on a DiskWorkingTree can ONLY access paths under its root.
//
// We set up a host directory with a sensitive file outside the sandbox
// (e.g. /tmp/<tmp>/secret.txt) and verify that no IFileSystem operation
// can read it, write to it, list it, stat it, or otherwise observe it
// from inside a sandbox at /tmp/<tmp>/sandbox.

describe("DiskWorkingTree escape prevention", () => {
  let hostDir: string; // the parent — contains secret + sandbox
  let sandboxDir: string; // the working tree root
  let secretFile: string; // outside the sandbox
  let fs: DiskWorkingTree;

  beforeEach(() => {
    hostDir = mkdtempSync(join(tmpdir(), "just-stash-escape-"));
    sandboxDir = join(hostDir, "sandbox");
    secretFile = join(hostDir, "secret.txt");
    mkdirSync(sandboxDir);
    writeFileSync(secretFile, "TOP SECRET");
    fs = new DiskWorkingTree({ root: sandboxDir });
  });

  afterEach(() => {
    rmSync(hostDir, { recursive: true, force: true });
  });

  describe("parent-directory traversal", () => {
    it('readFile with ".." path is rejected', async () => {
      await expect(fs.readFile("/../secret.txt")).rejects.toThrow("ENOENT");
    });

    it('readFile with deeply nested ".." is rejected', async () => {
      await expect(fs.readFile("/a/b/../../../secret.txt")).rejects.toThrow("ENOENT");
    });

    it('readFile with ".." inside a path is rejected even if it would land inside', async () => {
      // /foo/../bar normalizes to /bar — but we reject any '..' segment
      // because the agent's intent is unclear.
      await fs.writeFile("/bar.txt", "inside");
      await expect(fs.readFile("/foo/../bar.txt")).rejects.toThrow("ENOENT");
    });

    it('writeFile with ".." cannot escape', async () => {
      await expect(fs.writeFile("/../secret.txt", "OVERWRITTEN")).rejects.toThrow("ENOENT");
      // Confirm the host file is untouched
      const onDisk = require("node:fs").readFileSync(secretFile, "utf8");
      expect(onDisk).toBe("TOP SECRET");
    });

    it('rm with ".." cannot reach outside', async () => {
      await expect(fs.rm("/../secret.txt")).rejects.toThrow("ENOENT");
      expect(require("node:fs").existsSync(secretFile)).toBe(true);
    });

    it('exists with ".." returns false', async () => {
      expect(await fs.exists("/../secret.txt")).toBe(false);
    });

    it('stat with ".." throws ENOENT', async () => {
      await expect(fs.stat("/../secret.txt")).rejects.toThrow("ENOENT");
    });
  });

  describe("absolute-path injection", () => {
    // All input paths to a DiskWorkingTree are interpreted as virtual
    // paths under root. Even '/etc/passwd' maps to <root>/etc/passwd.
    // We verify that's what happens — no host /etc/passwd is touched.

    it('readFile("/etc/passwd") looks INSIDE the sandbox, not the host', async () => {
      // No /etc/passwd inside the sandbox, so this should ENOENT.
      await expect(fs.readFile("/etc/passwd")).rejects.toThrow("ENOENT");
      // Writing to /etc/passwd should also go inside the sandbox.
      await fs.writeFile("/etc/passwd", "fake");
      const actual = require("node:fs").readFileSync(join(sandboxDir, "etc", "passwd"), "utf8");
      expect(actual).toBe("fake");
      // Host /etc/passwd untouched (would be a real one in /etc on this machine)
    });
  });

  describe("symlink escape", () => {
    it("cannot read through a symlink that points outside the sandbox", async () => {
      // Create symlink directly on disk pointing outside the sandbox.
      // This simulates an attacker who somehow got a symlink into the
      // tree (e.g. a malformed snapshot, or a misbehaving subprocess
      // if there were one — for us this shouldn't normally happen but
      // we defend anyway).
      symlinkSync(secretFile, join(sandboxDir, "leak"));

      await expect(fs.readFile("/leak")).rejects.toThrow("ENOENT");
      await expect(fs.readFileBuffer("/leak")).rejects.toThrow("ENOENT");
      await expect(fs.stat("/leak")).rejects.toThrow("ENOENT");
    });

    it("cannot read through a symlink that points to a host directory", async () => {
      // /tmp/<hostDir> — but trying to read INSIDE it via a sandbox symlink
      symlinkSync(hostDir, join(sandboxDir, "host"));
      await expect(fs.readFile("/host/secret.txt")).rejects.toThrow("ENOENT");
      // Even readdir on the link should refuse
      await expect(fs.readdir("/host")).rejects.toThrow("ENOENT");
    });

    it("cannot write through a symlink that points outside the sandbox", async () => {
      symlinkSync(secretFile, join(sandboxDir, "leak"));
      await expect(fs.writeFile("/leak", "OVERWRITTEN")).rejects.toThrow("ENOENT");
      const onDisk = require("node:fs").readFileSync(secretFile, "utf8");
      expect(onDisk).toBe("TOP SECRET");
    });

    it("cannot traverse a symlink in an intermediate path component", async () => {
      // Symlink /sandbox/exit → /<hostDir>
      symlinkSync(hostDir, join(sandboxDir, "exit"));
      // /exit/secret.txt has 'exit' as an intermediate path component
      // (well, leaf component in this case, but still: we never follow
      // it during resolution). Try a path that REQUIRES traversing it.
      writeFileSync(join(hostDir, "inside.txt"), "host file");
      await expect(fs.readFile("/exit/inside.txt")).rejects.toThrow("ENOENT");
    });

    it("symlink creation with absolute target is rejected", async () => {
      await expect(fs.symlink("/etc/passwd", "/leak")).rejects.toThrow("ENOENT");
      expect(require("node:fs").existsSync(join(sandboxDir, "leak"))).toBe(false);
    });

    it('symlink creation with ".." target that escapes is rejected', async () => {
      await expect(fs.symlink("../../../etc/passwd", "/leak")).rejects.toThrow("ENOENT");
      expect(require("node:fs").existsSync(join(sandboxDir, "leak"))).toBe(false);
    });

    it("symlink with safe relative target inside sandbox is allowed", async () => {
      await fs.writeFile("/target.txt", "inside");
      await fs.symlink("target.txt", "/link");
      // The link exists on disk but reading through it still fails
      // (we don't follow links). readlink, however, works.
      expect(await fs.readlink("/link")).toBe("target.txt");
      await expect(fs.readFile("/link")).rejects.toThrow("ENOENT");
    });
  });

  describe("null bytes and weird inputs", () => {
    it("null bytes in paths are rejected", async () => {
      await expect(fs.readFile("/foo\0bar")).rejects.toThrow("ENOENT");
      await expect(fs.writeFile("/foo\0", "x")).rejects.toThrow("ENOENT");
    });

    it("empty path is rejected", async () => {
      await expect(fs.readFile("")).rejects.toThrow("ENOENT");
    });

    it("Windows-style separators are rejected", async () => {
      await expect(fs.readFile("\\foo\\bar")).rejects.toThrow("ENOENT");
      await expect(fs.writeFile("foo\\bar", "x")).rejects.toThrow("ENOENT");
    });
  });

  describe("rm with force on excluded paths", () => {
    it('rm of a "../escape" path with force returns silently, no host damage', async () => {
      await fs.rm("/../secret.txt", { force: true });
      expect(require("node:fs").existsSync(secretFile)).toBe(true);
    });
  });

  describe("cp / mv cannot bridge in or out", () => {
    it("cp from an escaping src is rejected", async () => {
      await fs.writeFile("/inside.txt", "x");
      await expect(fs.cp("/../secret.txt", "/copy.txt")).rejects.toThrow("ENOENT");
    });

    it("recursive cp preserves relative symlink targets", async () => {
      await fs.writeFile("/secret.txt", "inside");
      await fs.mkdir("/sub");
      await fs.symlink("../secret.txt", "/sub/link");

      await fs.cp("/sub", "/subcopy", { recursive: true });

      expect(await fs.readlink("/subcopy/link")).toBe("../secret.txt");
    });

    it("mv to an escaping dest is rejected", async () => {
      await fs.writeFile("/source.txt", "x");
      await expect(fs.mv("/source.txt", "/../moved.txt")).rejects.toThrow("ENOENT");
    });
  });

  describe("what IS allowed", () => {
    it("plain reads and writes within root", async () => {
      await fs.writeFile("/file.txt", "content");
      expect(await fs.readFile("/file.txt")).toBe("content");
    });

    it("nested dirs work", async () => {
      await fs.mkdir("/a/b/c", { recursive: true });
      await fs.writeFile("/a/b/c/file.txt", "deep");
      expect(await fs.readFile("/a/b/c/file.txt")).toBe("deep");
    });

    it("relative paths in target resolve relative to root", async () => {
      await fs.writeFile("relative.txt", "works");
      expect(await fs.readFile("/relative.txt")).toBe("works");
    });

    it("readdir works for valid paths", async () => {
      await fs.writeFile("/a.txt", "a");
      await fs.writeFile("/b.txt", "b");
      const entries = await fs.readdir("/");
      expect(entries.sort()).toEqual(["a.txt", "b.txt"]);
    });
  });
});
