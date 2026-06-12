import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryFs } from "just-bash";
import { GitBackend } from "../src/backends/git.ts";
import { PersistentFs } from "../src/wrappers/persistent-fs.ts";
import { CasConflictError } from "../src/types.ts";

describe("GitBackend (local)", () => {
  let tmpDir: string;
  let backend: GitBackend;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "just-stash-git-test-"));
    backend = new GitBackend({ cacheDir: join(tmpDir, "alice.git") });
    await backend.initialize();
  });

  afterEach(async () => {
    await backend.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("basic lifecycle", () => {
    it("empty backend has null HEAD", async () => {
      expect(await backend.readHead()).toBeNull();
    });

    it("commit then restore round-trips files", async () => {
      const fs1 = new PersistentFs(new InMemoryFs(), { backend });
      await fs1.boot();
      await fs1.writeFile("/app.ts", "export const x = 42;");
      await fs1.writeFile("/data/notes.md", "# Notes");
      const info = await fs1.commit({ trigger: "turn_end" });
      expect(info.snapshotId).toMatch(/^[a-f0-9]{40}$/); // SHA-1, not SHA-256

      const fs2 = new PersistentFs(new InMemoryFs(), { backend });
      await fs2.boot();
      expect(await fs2.readFile("/app.ts")).toBe("export const x = 42;");
      expect(await fs2.readFile("/data/notes.md")).toBe("# Notes");
    });

    it("multiple commits form a chain", async () => {
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();
      await fs.writeFile("/v.txt", "v1");
      const c1 = await fs.commit({ trigger: "first" });
      await fs.writeFile("/v.txt", "v2");
      const c2 = await fs.commit({ trigger: "second" });
      expect(c2.parentId).toBe(c1.snapshotId);

      const log = await fs.log();
      expect(log.length).toBe(2);
      expect(log[0].snapshotId).toBe(c2.snapshotId);
    });

    it("round-trips empty directories", async () => {
      const fs1 = new PersistentFs(new InMemoryFs(), { backend });
      await fs1.boot();
      await fs1.mkdir("/empty/nested", { recursive: true });
      await fs1.commit({ trigger: "turn_end" });

      const fs2 = new PersistentFs(new InMemoryFs(), { backend });
      await fs2.boot();
      expect(await fs2.exists("/empty/nested")).toBe(true);
      expect(await fs2.readdir("/empty/nested")).toEqual([]);
    });

    it("log without a limit returns the full chain", async () => {
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();

      for (let i = 0; i < 105; i++) {
        await fs.writeFile("/v.txt", `v${i}`);
        await fs.commit({ trigger: `c${i}` });
      }

      const log = await fs.log();
      expect(log).toHaveLength(105);
      expect(log[0].trigger).toBe("c104");
      expect(log[104].trigger).toBe("c0");
    });
  });

  describe("exclude from snapshots", () => {
    it("excluded subtrees do not appear in commits", async () => {
      const fs = new PersistentFs(new InMemoryFs(), {
        backend,
        excludeFromSnapshots: ["/scratch"],
      });
      await fs.boot();
      await fs.writeFile("/keep.txt", "persisted");
      await fs.mkdir("/scratch", { recursive: true });
      await fs.writeFile("/scratch/temp.txt", "transient");
      await fs.commit({ trigger: "turn_end" });

      const fresh = new PersistentFs(new InMemoryFs(), {
        backend,
        excludeFromSnapshots: ["/scratch"],
      });
      await fresh.boot();
      expect(await fresh.readFile("/keep.txt")).toBe("persisted");
      expect(await fresh.exists("/scratch/temp.txt")).toBe(false);
    });
  });

  describe("rollback", () => {
    it("moves HEAD back and restores files", async () => {
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();
      await fs.writeFile("/v.txt", "v1");
      const c1 = await fs.commit({ trigger: "turn_end" });
      await fs.writeFile("/v.txt", "v2");
      await fs.commit({ trigger: "turn_end" });

      await fs.rollback(c1.snapshotId);
      expect(await fs.readFile("/v.txt")).toBe("v1");
      expect(await backend.readHead()).toBe(c1.snapshotId);
    });
  });

  describe("diff", () => {
    it("reports added/modified/removed paths", async () => {
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();
      await fs.writeFile("/keep.txt", "unchanged");
      await fs.writeFile("/remove.txt", "will be removed");
      await fs.writeFile("/modify.txt", "v1");
      const c1 = await fs.commit({ trigger: "turn_end" });

      await fs.rm("/remove.txt");
      await fs.writeFile("/modify.txt", "v2-different");
      await fs.writeFile("/add.txt", "new");
      const c2 = await fs.commit({ trigger: "turn_end" });

      const changes = await fs.diff(c1.snapshotId, c2.snapshotId);
      const byPath = new Map(changes.map((c) => [c.path, c.kind]));
      expect(byPath.get("/add.txt")).toBe("added");
      expect(byPath.get("/remove.txt")).toBe("removed");
      expect(byPath.get("/modify.txt")).toBe("modified");
    });
  });

  describe("notes", () => {
    it("attach and read harness metadata", async () => {
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();
      await fs.writeFile("/x.txt", "x");
      const c = await fs.commit({
        trigger: "turn_end",
        note: "prompt: do X. response: done.",
      });
      const note = await fs.getNote(c.snapshotId);
      expect(note?.trim()).toBe("prompt: do X. response: done.");
    });
  });

  describe("CAS conflict", () => {
    it("concurrent commits race; only one wins", async () => {
      // Two backends pointing at the same on-disk repo
      const fsA = new PersistentFs(new InMemoryFs(), { backend });
      await fsA.boot();
      await fsA.writeFile("/seed.txt", "seed");
      await fsA.commit({ trigger: "seed" });

      // Simulate concurrent: read head, both write, both try commit
      const head = await backend.readHead();
      expect(head).not.toBeNull();

      // Sequential calls with same priorHead — second should conflict.
      // (Real concurrency would need two backends; this verifies CAS logic.)
      const result1 = await backend.commit({
        fs: new InMemoryFs({ "/a.txt": "A" }),
        excludePaths: [],
        priorHead: head,
        metadata: {
          trigger: "a",
          message: "a",
          author: { name: "x", email: "x@y" },
          timestamp: Date.now(),
        },
      });
      expect(result1.snapshotId).toBeDefined();

      await expect(
        backend.commit({
          fs: new InMemoryFs({ "/b.txt": "B" }),
          excludePaths: [],
          priorHead: head,
          metadata: {
            trigger: "b",
            message: "b",
            author: { name: "x", email: "x@y" },
            timestamp: Date.now(),
          },
        }),
      ).rejects.toThrow(CasConflictError);
    });

    it("same-instance concurrent commits serialize CAS; only one wins", async () => {
      const seedFs = new PersistentFs(new InMemoryFs(), { backend });
      await seedFs.boot();
      await seedFs.writeFile("/seed.txt", "seed");
      await seedFs.commit({ trigger: "seed" });

      const priorHead = await backend.readHead();
      expect(priorHead).not.toBeNull();

      const originalReadHead = backend.readHead.bind(backend);
      let delayedReads = 0;
      backend.readHead = async () => {
        const head = await originalReadHead();
        if (delayedReads < 2) {
          delayedReads++;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return head;
      };

      try {
        const metadata = {
          author: { name: "x", email: "x@y" },
          timestamp: Date.now(),
        };
        const results = await Promise.allSettled([
          backend.commit({
            fs: new InMemoryFs({ "/a.txt": "A" }),
            excludePaths: [],
            priorHead,
            metadata: { ...metadata, trigger: "a", message: "a" },
          }),
          backend.commit({
            fs: new InMemoryFs({ "/b.txt": "B" }),
            excludePaths: [],
            priorHead,
            metadata: { ...metadata, trigger: "b", message: "b" },
          }),
        ]);

        const fulfilled = results.filter((result) => result.status === "fulfilled");
        const rejected = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );

        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect(rejected[0].reason).toBeInstanceOf(CasConflictError);
        expect(await backend.log({ limit: 10 })).toHaveLength(2);
      } finally {
        backend.readHead = originalReadHead;
      }
    });
  });

  describe("fork (native)", () => {
    it("forks share commit history", async () => {
      const fs1 = new PersistentFs(new InMemoryFs(), { backend });
      await fs1.boot();
      await fs1.writeFile("/shared.txt", "baseline");
      await fs1.commit({ trigger: "baseline" });

      const dstBackend = new GitBackend({ cacheDir: join(tmpDir, "bob.git") });
      await dstBackend.initialize();

      const fs2 = await PersistentFs.fork({
        src: fs1,
        dst: dstBackend,
        innerFactory: () => new InMemoryFs(),
      });

      expect(await fs2.readFile("/shared.txt")).toBe("baseline");
      // dst HEAD equals src HEAD (same commit OID shared)
      const srcHead = await backend.readHead();
      const dstHead = await dstBackend.readHead();
      expect(dstHead).toBe(srcHead);

      await dstBackend.close();
    });
  });

  describe("inner mountable filesystem", () => {
    it("handles nested directories correctly", async () => {
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();
      await fs.mkdir("/a/b/c", { recursive: true });
      await fs.writeFile("/a/b/c/deep.txt", "deep content");
      await fs.writeFile("/a/top.txt", "top content");
      await fs.commit({ trigger: "turn_end" });

      const fresh = new PersistentFs(new InMemoryFs(), { backend });
      await fresh.boot();
      expect(await fresh.readFile("/a/b/c/deep.txt")).toBe("deep content");
      expect(await fresh.readFile("/a/top.txt")).toBe("top content");
    });
  });
});
