import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryFs } from "just-bash";
import { BlobBackend } from "../src/backends/blob.ts";
import { PersistentFs } from "../src/wrappers/persistent-fs.ts";
import { CasConflictError } from "../src/types.ts";

// Probe better-sqlite3 native bindings; skip suite if they can't load.
let SqliteStore: typeof import("../src/stores/sqlite.ts").SqliteStore;
let bindingsOk = false;
try {
  ({ SqliteStore } = await import("../src/stores/sqlite.ts"));
  const probe = new SqliteStore(":memory:");
  await probe.initialize();
  await probe.close();
  bindingsOk = true;
} catch {
  /* skip */
}

describe.skipIf(!bindingsOk)("SqliteStore", () => {
  let tmpDir: string;
  let store: InstanceType<typeof SqliteStore>;
  let backend: BlobBackend;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "just-stash-sqlite-"));
    store = new SqliteStore(join(tmpDir, "test.db"));
    await store.initialize();
    backend = new BlobBackend({ blobs: store, metadata: store });
  });

  afterEach(async () => {
    await backend.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("BlobStore contract", () => {
    it("put returns sha256, idempotent", async () => {
      const id1 = await store.put(Buffer.from("hello"));
      const id2 = await store.put(Buffer.from("hello"));
      expect(id1).toMatch(/^[a-f0-9]{64}$/);
      expect(id1).toBe(id2);
    });

    it("get round-trips", async () => {
      const data = Buffer.from("round-trip");
      const id = await store.put(data);
      const got = await store.get(id);
      expect(got.equals(data)).toBe(true);
    });

    it("exists is accurate", async () => {
      const id = await store.put(Buffer.from("x"));
      expect(await store.exists(id)).toBe(true);
      expect(await store.exists("missing")).toBe(false);
    });
  });

  describe("MetadataStore contract", () => {
    it("readHead null when empty", async () => {
      expect(await store.readHead()).toBeNull();
    });

    it("appendCommit + readHead chain", async () => {
      await store.appendCommit({
        commit: {
          snapshotId: "sha1" as any,
          contentId: "blob1" as any,
          parentId: null,
          trigger: "t",
          message: "m",
          author: { name: "a", email: "a@b" },
          timestamp: 1000,
        },
        priorHead: null,
      });
      expect(await store.readHead()).toBe("sha1");
      expect((await store.getCommit("sha1" as any))?.contentId).toBe("blob1");

      await store.appendCommit({
        commit: {
          snapshotId: "sha2" as any,
          parentId: "sha1" as any,
          trigger: "t",
          message: "m",
          author: { name: "a", email: "a@b" },
          timestamp: 2000,
        },
        priorHead: "sha1" as any,
      });
      expect(await store.readHead()).toBe("sha2");
    });

    it("appendCommit throws CasConflictError on mismatch", async () => {
      await store.appendCommit({
        commit: {
          snapshotId: "sha1" as any,
          parentId: null,
          trigger: "t",
          message: "m",
          author: { name: "a", email: "a@b" },
          timestamp: 1000,
        },
        priorHead: null,
      });
      await expect(
        store.appendCommit({
          commit: {
            snapshotId: "sha2" as any,
            parentId: null,
            trigger: "t",
            message: "m",
            author: { name: "a", email: "a@b" },
            timestamp: 2000,
          },
          priorHead: null, // wrong — HEAD is now sha1
        }),
      ).rejects.toBeInstanceOf(CasConflictError);
    });

    it("log walks the chain newest-first", async () => {
      for (let i = 0; i < 3; i++) {
        await store.appendCommit({
          commit: {
            snapshotId: `sha${i}` as any,
            parentId: i === 0 ? null : (`sha${i - 1}` as any),
            trigger: `c${i}`,
            message: `m${i}`,
            author: { name: "a", email: "a@b" },
            timestamp: i * 1000,
          },
          priorHead: i === 0 ? null : (`sha${i - 1}` as any),
        });
      }
      const log = await store.log();
      expect(log.map((c) => c.snapshotId)).toEqual(["sha2", "sha1", "sha0"]);
    });

    it("notes round-trip", async () => {
      await store.appendCommit({
        commit: {
          snapshotId: "sha1" as any,
          parentId: null,
          trigger: "t",
          message: "m",
          author: { name: "a", email: "a@b" },
          timestamp: 1000,
        },
        priorHead: null,
      });
      await store.putNote("sha1" as any, "hello note");
      expect(await store.getNote("sha1" as any)).toBe("hello note");
      // overwrite
      await store.putNote("sha1" as any, "updated");
      expect(await store.getNote("sha1" as any)).toBe("updated");
    });

    it("listCommitIds yields all stored ids", async () => {
      for (let i = 0; i < 3; i++) {
        await store.appendCommit({
          commit: {
            snapshotId: `c${i}` as any,
            parentId: i === 0 ? null : (`c${i - 1}` as any),
            trigger: "t",
            message: "m",
            author: { name: "a", email: "a@b" },
            timestamp: i,
          },
          priorHead: i === 0 ? null : (`c${i - 1}` as any),
        });
      }
      const ids: string[] = [];
      for await (const id of store.listCommitIds()) ids.push(id);
      expect(ids.sort()).toEqual(["c0", "c1", "c2"]);
    });

    it("deleteCommit removes commit + note in one operation", async () => {
      await store.appendCommit({
        commit: {
          snapshotId: "sha1" as any,
          parentId: null,
          trigger: "t",
          message: "m",
          author: { name: "a", email: "a@b" },
          timestamp: 1000,
        },
        priorHead: null,
      });
      await store.putNote("sha1" as any, "metadata");
      await store.deleteCommit("sha1" as any);
      expect(await store.getCommit("sha1" as any)).toBeNull();
      expect(await store.getNote("sha1" as any)).toBeNull();
    });
  });

  describe("PersistentFs integration", () => {
    it("persists across handle re-open", async () => {
      const fs1 = new PersistentFs(new InMemoryFs(), { backend });
      await fs1.boot();
      await fs1.writeFile("/x.txt", "persisted");
      await fs1.commit({ trigger: "turn_end" });
      await backend.close();

      // Re-open at same path
      const store2 = new SqliteStore(join(tmpDir, "test.db"));
      await store2.initialize();
      const backend2 = new BlobBackend({ blobs: store2, metadata: store2 });

      const fs2 = new PersistentFs(new InMemoryFs(), { backend: backend2 });
      await fs2.boot();
      expect(await fs2.readFile("/x.txt")).toBe("persisted");

      await backend2.close();
    });
  });
});
