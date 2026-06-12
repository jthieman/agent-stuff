import { describe, it, expect, beforeEach } from "vite-plus/test";
import { InMemoryFs, MountableFs } from "just-bash";
import { PersistentFs } from "../src/wrappers/persistent-fs.ts";
import { MemoryBackend } from "../src/stores/memory.ts";
import { CasConflictError } from "../src/types.ts";

describe("PersistentFs + MemoryBackend", () => {
  let backend: MemoryBackend;

  beforeEach(() => {
    backend = new MemoryBackend();
  });

  describe("basic lifecycle", () => {
    it("boot on empty backend leaves inner empty", async () => {
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();
      expect(await fs.readdir("/")).toEqual([]);
    });

    it("boot on empty backend clears stale inner state", async () => {
      const inner = new InMemoryFs({ "/stale.txt": "old" });
      const fs = new PersistentFs(inner, { backend });
      await fs.boot();
      expect(await fs.exists("/stale.txt")).toBe(false);
    });

    it("commit then re-boot restores files", async () => {
      const fs1 = new PersistentFs(new InMemoryFs(), { backend });
      await fs1.boot();
      await fs1.writeFile("/app.ts", "export const x = 42;");
      await fs1.mkdir("/data", { recursive: true });
      await fs1.writeFile("/data/notes.md", "# Notes");
      const info = await fs1.commit({ trigger: "turn_end" });
      expect(info.snapshotId).toBeDefined();
      expect(info.parentId).toBeNull();

      const fs2 = new PersistentFs(new InMemoryFs(), { backend });
      await fs2.boot();
      expect(await fs2.readFile("/app.ts")).toBe("export const x = 42;");
      expect(await fs2.readFile("/data/notes.md")).toBe("# Notes");
    });

    it("multiple commits chain via parentId", async () => {
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();

      await fs.writeFile("/v.txt", "v1");
      const c1 = await fs.commit({ trigger: "turn_end" });

      await fs.writeFile("/v.txt", "v2");
      const c2 = await fs.commit({ trigger: "turn_end" });

      expect(c1.parentId).toBeNull();
      expect(c2.parentId).toBe(c1.snapshotId);
    });

    it("boot clears existing inner before restoring", async () => {
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();
      await fs.writeFile("/keep.txt", "keep");
      await fs.commit({ trigger: "turn_end" });
      // Add stale files
      await fs.writeFile("/stale.txt", "should disappear");
      // Re-boot
      await fs.boot();
      expect(await fs.exists("/keep.txt")).toBe(true);
      expect(await fs.exists("/stale.txt")).toBe(false);
    });
  });

  describe("exclude from snapshots", () => {
    it("excluded paths are NOT in the snapshot", async () => {
      const fs = new PersistentFs(new InMemoryFs(), {
        backend,
        excludeFromSnapshots: ["/scratch"],
      });
      await fs.boot();
      await fs.writeFile("/keep.txt", "persisted");
      await fs.mkdir("/scratch", { recursive: true });
      await fs.writeFile("/scratch/tmp.txt", "transient");
      await fs.commit({ trigger: "turn_end" });

      // Fresh fs reads back only /keep.txt
      const fresh = new PersistentFs(new InMemoryFs(), {
        backend,
        excludeFromSnapshots: ["/scratch"],
      });
      await fresh.boot();
      expect(await fresh.exists("/keep.txt")).toBe(true);
      expect(await fresh.exists("/scratch/tmp.txt")).toBe(false);
    });

    it("excludes work on MountableFs mounts", async () => {
      const buildInner = () =>
        new MountableFs({
          mounts: [
            { mountPoint: "/workspace", filesystem: new InMemoryFs() },
            { mountPoint: "/scratch", filesystem: new InMemoryFs() },
          ],
        });

      const fs = new PersistentFs(buildInner(), {
        backend,
        excludeFromSnapshots: ["/scratch"],
      });
      await fs.boot();
      await fs.writeFile("/workspace/code.ts", "persisted");
      await fs.writeFile("/scratch/junk.txt", "transient");
      await fs.commit({ trigger: "turn_end" });

      const fresh = new PersistentFs(buildInner(), {
        backend,
        excludeFromSnapshots: ["/scratch"],
      });
      await fresh.boot();
      expect(await fresh.readFile("/workspace/code.ts")).toBe("persisted");
      expect(await fresh.exists("/scratch/junk.txt")).toBe(false);
    });

    it("normalizes exclude paths (trailing slash, missing slash)", async () => {
      const fs = new PersistentFs(new InMemoryFs(), {
        backend,
        excludeFromSnapshots: ["scratch/", "/cache"],
      });
      await fs.boot();
      await fs.mkdir("/scratch", { recursive: true });
      await fs.mkdir("/cache", { recursive: true });
      await fs.writeFile("/scratch/x.txt", "x");
      await fs.writeFile("/cache/y.txt", "y");
      await fs.commit({ trigger: "turn_end" });

      const fresh = new PersistentFs(new InMemoryFs(), { backend });
      await fresh.boot();
      expect(await fresh.exists("/scratch")).toBe(false);
      expect(await fresh.exists("/cache")).toBe(false);
    });
  });

  describe("rollback", () => {
    it("restores a previous snapshot and moves HEAD", async () => {
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();
      await fs.writeFile("/v.txt", "v1");
      const c1 = await fs.commit({ trigger: "turn_end" });

      await fs.writeFile("/v.txt", "v2");
      const c2 = await fs.commit({ trigger: "turn_end" });

      await fs.rollback(c1.snapshotId);
      expect(await fs.readFile("/v.txt")).toBe("v1");
      expect(await backend.readHead()).toBe(c1.snapshotId);

      // The c2 commit still exists in storage (history preserved).
      expect(await backend.getNote(c2.snapshotId)).toBeNull();
    });
  });

  describe("log", () => {
    it("returns commits newest first", async () => {
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();
      await fs.writeFile("/a.txt", "a");
      const c1 = await fs.commit({ trigger: "first" });
      await fs.writeFile("/b.txt", "b");
      const c2 = await fs.commit({ trigger: "second" });

      const history = await fs.log();
      expect(history.length).toBe(2);
      expect(history[0].snapshotId).toBe(c2.snapshotId);
      expect(history[1].snapshotId).toBe(c1.snapshotId);
    });

    it("respects limit", async () => {
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();
      for (let i = 0; i < 5; i++) {
        await fs.writeFile("/v.txt", `v${i}`);
        await fs.commit({ trigger: `c${i}` });
      }
      const history = await fs.log({ limit: 2 });
      expect(history.length).toBe(2);
    });
  });

  describe("diff", () => {
    it("reports added, modified, removed paths", async () => {
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();
      await fs.writeFile("/keep.txt", "unchanged");
      await fs.writeFile("/remove.txt", "will be removed");
      await fs.writeFile("/modify.txt", "v1");
      const c1 = await fs.commit({ trigger: "turn_end" });

      await fs.rm("/remove.txt");
      await fs.writeFile("/modify.txt", "v2-different-content");
      await fs.writeFile("/add.txt", "brand new");
      const c2 = await fs.commit({ trigger: "turn_end" });

      const changes = await fs.diff(c1.snapshotId, c2.snapshotId);
      const byPath = new Map(changes.map((c) => [c.path, c.kind]));
      expect(byPath.get("/add.txt")).toBe("added");
      expect(byPath.get("/remove.txt")).toBe("removed");
      expect(byPath.get("/modify.txt")).toBe("modified");
      expect(byPath.has("/keep.txt")).toBe(false);
    });

    it("reports same-size content changes as modified", async () => {
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();
      await fs.writeFile("/same-size.txt", "aaaa");
      const c1 = await fs.commit({ trigger: "one" });

      await fs.writeFile("/same-size.txt", "bbbb");
      const c2 = await fs.commit({ trigger: "two" });

      expect(await fs.diff(c1.snapshotId, c2.snapshotId)).toEqual([
        { path: "/same-size.txt", kind: "modified" },
      ]);
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
      expect(await fs.getNote(c.snapshotId)).toBe("prompt: do X. response: done.");
    });

    it("addNote after commit works too", async () => {
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();
      await fs.writeFile("/x.txt", "x");
      const c = await fs.commit({ trigger: "turn_end" });
      await fs.addNote(c.snapshotId, "added later");
      expect(await fs.getNote(c.snapshotId)).toBe("added later");
    });
  });

  describe("CAS", () => {
    it("concurrent commits race — first wins, second throws", async () => {
      const handleA = backend.cloneHandle();
      const handleB = backend.cloneHandle();

      const fsA = new PersistentFs(new InMemoryFs(), { backend: handleA });
      const fsB = new PersistentFs(new InMemoryFs(), { backend: handleB });

      // Both boot from empty
      await fsA.boot();
      await fsB.boot();

      // Both write something different
      await fsA.writeFile("/a.txt", "A");
      await fsB.writeFile("/b.txt", "B");

      // Both commit; the first one wins, the second sees CAS conflict
      const results = await Promise.allSettled([
        fsA.commit({ trigger: "a" }),
        fsB.commit({ trigger: "b" }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CasConflictError);
    });

    it("stale since-boot commits conflict even if another writer already advanced HEAD", async () => {
      const handleA = backend.cloneHandle();
      const handleB = backend.cloneHandle();

      const fsA = new PersistentFs(new InMemoryFs(), { backend: handleA });
      const fsB = new PersistentFs(new InMemoryFs(), { backend: handleB });
      await fsA.boot();
      await fsB.boot();

      await fsB.writeFile("/b.txt", "B");
      await fsB.commit({ trigger: "b" });

      await fsA.writeFile("/a.txt", "A");
      await expect(fsA.commit({ trigger: "a" })).rejects.toBeInstanceOf(CasConflictError);
    });

    it("identical content commits dedupe blob content but keep distinct commit ids", async () => {
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();
      await fs.writeFile("/x.txt", "identical");
      const c1 = await fs.commit({ trigger: "turn_end" });
      const c2 = await fs.commit({ trigger: "turn_end" });
      expect(c1.snapshotId).not.toBe(c2.snapshotId);
      expect(c1.contentId).toBe(c2.contentId);
      expect(c2.parentId).toBe(c1.snapshotId);

      const history = await fs.log({ limit: 10 });
      expect(history.map((c) => c.snapshotId)).toEqual([c2.snapshotId, c1.snapshotId]);
    });

    it("rollback conflict leaves the working tree untouched", async () => {
      const handleA = backend.cloneHandle();
      const handleB = backend.cloneHandle();

      const fsA = new PersistentFs(new InMemoryFs(), { backend: handleA });
      await fsA.boot();
      await fsA.writeFile("/v.txt", "v1");
      const c1 = await fsA.commit({ trigger: "one" });
      await fsA.writeFile("/v.txt", "v2");
      await fsA.commit({ trigger: "two" });

      const fsB = new PersistentFs(new InMemoryFs(), { backend: handleB });
      await fsB.boot();
      await fsB.writeFile("/other.txt", "v3");
      await fsB.commit({ trigger: "three" });

      await expect(fsA.rollback(c1.snapshotId)).rejects.toBeInstanceOf(CasConflictError);
      expect(await fsA.readFile("/v.txt")).toBe("v2");
    });
  });

  describe("fork", () => {
    it("creates a new session with the same starting state", async () => {
      const fs1 = new PersistentFs(new InMemoryFs(), { backend });
      await fs1.boot();
      await fs1.writeFile("/shared.txt", "baseline");
      await fs1.commit({ trigger: "baseline" });

      const dst = new MemoryBackend();
      const fs2 = await PersistentFs.fork({
        src: fs1,
        dst,
        innerFactory: () => new InMemoryFs(),
      });

      expect(await fs2.readFile("/shared.txt")).toBe("baseline");
    });

    it("forks diverge independently", async () => {
      const fs1 = new PersistentFs(new InMemoryFs(), { backend });
      await fs1.boot();
      await fs1.writeFile("/file.txt", "original");
      await fs1.commit({ trigger: "turn_end" });

      const dst = new MemoryBackend();
      const fs2 = await PersistentFs.fork({
        src: fs1,
        dst,
        innerFactory: () => new InMemoryFs(),
      });

      await fs2.writeFile("/file.txt", "changed");
      await fs2.commit({ trigger: "turn_end" });

      // Original unchanged
      const fresh = new PersistentFs(new InMemoryFs(), { backend });
      await fresh.boot();
      expect(await fresh.readFile("/file.txt")).toBe("original");
    });
  });
});
