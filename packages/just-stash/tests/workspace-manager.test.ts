import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceManager, SandboxLockedError } from "../src/disk/workspace-manager.ts";
import type { SandboxHandle } from "../src/disk/workspace-manager.ts";
import { MemoryBackend } from "../src/stores/memory.ts";

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r as (value?: T | PromiseLike<T>) => void;
  });
  return { promise, resolve };
}

describe("WorkspaceManager", () => {
  let root: string;
  let manager: WorkspaceManager;
  // One MemoryBackend per sandboxId, persisted across acquires (the
  // factory returns a fresh handle to the SAME state via cloneHandle).
  const backends = new Map<string, MemoryBackend>();

  function backendFor(id: string): MemoryBackend {
    if (!backends.has(id)) backends.set(id, new MemoryBackend());
    return backends.get(id)!;
  }

  function backendWithBlockedFirstReadHead(
    backend: MemoryBackend,
    started: Deferred,
    resume: Deferred,
  ): MemoryBackend {
    const readHead = backend.readHead.bind(backend);
    let shouldBlock = true;
    backend.readHead = async () => {
      if (shouldBlock) {
        shouldBlock = false;
        started.resolve();
        await resume.promise;
      }
      return readHead();
    };
    return backend;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "just-stash-wm-"));
    backends.clear();
    manager = new WorkspaceManager({
      root,
      defaults: {
        backendFactory: (id) => backendFor(id).cloneHandle(),
      },
      ttlMs: 60_000,
    });
  });

  afterEach(async () => {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  });

  describe("acquire / release", () => {
    it("acquire creates the tree directory", async () => {
      const handle = await manager.acquire("alice");
      expect(existsSync(handle.treePath)).toBe(true);
      await handle.release();
    });

    it("writes via the handle land on disk", async () => {
      const handle = await manager.acquire("alice");
      await handle.fs.writeFile("/file.txt", "hello");
      expect(existsSync(join(handle.treePath, "file.txt"))).toBe(true);
      await handle.release();
    });

    it("commit persists; second acquire restores", async () => {
      const handle1 = await manager.acquire("alice");
      await handle1.fs.writeFile("/file.txt", "persisted");
      await handle1.fs.commit({ trigger: "turn_end" });
      await handle1.dispose();

      // Evict the tree to simulate cold restart
      await manager.evict("alice");

      const handle2 = await manager.acquire("alice");
      expect(await handle2.fs.readFile("/file.txt")).toBe("persisted");
      await handle2.release();
    });

    it("second concurrent acquire of same sandbox fails", async () => {
      const h1 = await manager.acquire("alice");
      await expect(manager.acquire("alice")).rejects.toBeInstanceOf(SandboxLockedError);
      await h1.release();
      // Now succeeds
      const h2 = await manager.acquire("alice");
      await h2.release();
    });

    it("different sandboxes are independent", async () => {
      const a = await manager.acquire("alice");
      const b = await manager.acquire("bob");
      await a.fs.writeFile("/x.txt", "alice");
      await b.fs.writeFile("/x.txt", "bob");
      expect(await a.fs.readFile("/x.txt")).toBe("alice");
      expect(await b.fs.readFile("/x.txt")).toBe("bob");
      await a.release();
      await b.release();
    });
  });

  describe("sandbox ID validation", () => {
    it('rejects ".."', async () => {
      await expect(manager.acquire("..")).rejects.toThrow("Invalid sandboxId");
    });
    it("rejects slashes", async () => {
      await expect(manager.acquire("alice/escape")).rejects.toThrow("Invalid sandboxId");
    });
    it("rejects leading dot", async () => {
      await expect(manager.acquire(".hidden")).rejects.toThrow("Invalid sandboxId");
    });
    it("rejects null bytes", async () => {
      await expect(manager.acquire("alice\0bob")).rejects.toThrow("Invalid sandboxId");
    });
    it("accepts normal IDs", async () => {
      const h = await manager.acquire("alice-123_v2");
      await h.release();
    });
  });

  describe("warm boot optimization", () => {
    it("re-acquire after release uses cached tree (no restore)", async () => {
      const h1 = await manager.acquire("alice");
      await h1.fs.writeFile("/big.txt", "x".repeat(1000));
      await h1.fs.commit({ trigger: "turn_end" });
      await h1.release();

      // Re-acquire — tree should still be there
      const h2 = await manager.acquire("alice");
      // The file should still exist (warm boot, no restore needed)
      expect(await h2.fs.readFile("/big.txt")).toBe("x".repeat(1000));
      // And the tree dir wasn't recreated
      expect(existsSync(join(h2.treePath, "big.txt"))).toBe(true);
      await h2.release();
    });

    it("re-acquire after uncommitted changes clears the dirty cached tree", async () => {
      const h1 = await manager.acquire("alice");
      await h1.fs.writeFile("/uncommitted.txt", "scratch");
      await h1.release();

      const h2 = await manager.acquire("alice");
      expect(await h2.fs.exists("/uncommitted.txt")).toBe(false);
      await h2.release();
    });

    it("re-acquire after crash-without-release clears the dirty cached tree", async () => {
      const crashedManager = manager;
      const h1 = await crashedManager.acquire("alice");
      await h1.fs.writeFile("/uncommitted.txt", "scratch");

      // Simulate process restart: same root and backend state, fresh
      // in-memory manager with no active handles.
      manager = new WorkspaceManager({
        root,
        defaults: {
          backendFactory: (id) => backendFor(id).cloneHandle(),
        },
        ttlMs: 60_000,
      });

      const h2 = await manager.acquire("alice");
      expect(await h2.fs.exists("/uncommitted.txt")).toBe(false);
      await h2.release();
      await crashedManager.close();
    });

    it("re-acquire after backend HEAD changed triggers restore", async () => {
      // Commit something via handle 1, release, then commit MORE via a
      // direct backend write, then re-acquire — should reflect the
      // newer state.
      const h1 = await manager.acquire("alice");
      await h1.fs.writeFile("/v.txt", "v1");
      await h1.fs.commit({ trigger: "first" });
      await h1.release();

      // Simulate another process committing through the same backend.
      // The backend factory clones the same shared state.
      const sideBackend = backendFor("alice").cloneHandle();
      const sideTreePath = join(root, "side-tree");
      require("node:fs").mkdirSync(sideTreePath);
      const { DiskWorkingTree } = await import("../src/disk/disk-working-tree.ts");
      const { PersistentFs } = await import("../src/wrappers/persistent-fs.ts");
      const sideFs = new PersistentFs(new DiskWorkingTree({ root: sideTreePath }), {
        backend: sideBackend,
      });
      await sideFs.boot();
      await sideFs.writeFile("/v.txt", "v2-from-elsewhere");
      await sideFs.commit({ trigger: "second" });

      // Re-acquire from manager — should restore the newer state
      const h2 = await manager.acquire("alice");
      expect(await h2.fs.readFile("/v.txt")).toBe("v2-from-elsewhere");
      await h2.release();
    });

    it("restores from the backend when clean meta remains but the tree is missing", async () => {
      const h1 = await manager.acquire("alice");
      await h1.fs.writeFile("/important.txt", "committed");
      await h1.fs.commit({ trigger: "turn_end" });
      const treePath = h1.treePath;
      await h1.release();

      rmSync(treePath, { recursive: true, force: true });

      await manager.close();
      manager = new WorkspaceManager({
        root,
        defaults: {
          backendFactory: (id) => backendFor(id).cloneHandle(),
        },
        ttlMs: 60_000,
      });

      const h2 = await manager.acquire("alice");
      expect(await h2.fs.readFile("/important.txt")).toBe("committed");
      await h2.release();
    });
  });

  describe("eviction", () => {
    it("explicit evict removes the tree", async () => {
      const h = await manager.acquire("alice");
      await h.fs.writeFile("/file.txt", "x");
      const treePath = h.treePath;
      await h.release();

      await manager.evict("alice");
      expect(existsSync(treePath)).toBe(false);
    });

    it("cannot evict a held sandbox", async () => {
      const h = await manager.acquire("alice");
      await expect(manager.evict("alice")).rejects.toBeInstanceOf(SandboxLockedError);
      await h.release();
    });

    it("TTL eviction removes stale trees on sweep", async () => {
      // Use a very short TTL
      const shortMgr = new WorkspaceManager({
        root,
        defaults: { backendFactory: (id) => backendFor(id).cloneHandle() },
        ttlMs: 50,
        sweepOnAcquire: false,
      });

      const h = await shortMgr.acquire("alice");
      const treePath = h.treePath;
      await h.release();

      await new Promise((r) => setTimeout(r, 100));
      const evicted = await shortMgr.sweep();
      expect(evicted).toContain("alice");
      expect(existsSync(treePath)).toBe(false);

      await shortMgr.close();
    });

    it("disk budget eviction removes oldest first", async () => {
      const budgetMgr = new WorkspaceManager({
        root: join(root, "budget"),
        defaults: { backendFactory: (id) => backendFor(id).cloneHandle() },
        ttlMs: 0, // disable TTL eviction
        maxDiskBytes: 200, // very small
        sweepOnAcquire: false,
      });

      // Create three sandboxes with files
      const a = await budgetMgr.acquire("a");
      await a.fs.writeFile("/data.bin", "a".repeat(150));
      await a.release();
      // Force a's timestamp to be older
      await new Promise((r) => setTimeout(r, 20));

      const b = await budgetMgr.acquire("b");
      await b.fs.writeFile("/data.bin", "b".repeat(150));
      await b.release();
      await new Promise((r) => setTimeout(r, 20));

      const c = await budgetMgr.acquire("c");
      await c.fs.writeFile("/data.bin", "c".repeat(150));
      await c.release();

      const evicted = await budgetMgr.sweep();
      // 'a' (oldest) should be evicted first to bring us under budget
      expect(evicted).toContain("a");
      // 'c' (newest) should survive
      expect(evicted).not.toContain("c");

      await budgetMgr.close();
    });

    it("TTL sweep does not evict a sandbox while acquire is pending", async () => {
      const readHeadStarted = deferred();
      const resumeReadHead = deferred();
      const pendingMgr = new WorkspaceManager({
        root: join(root, "pending-ttl"),
        defaults: {
          backendFactory: (id) =>
            id === "alice"
              ? backendWithBlockedFirstReadHead(
                  new MemoryBackend(),
                  readHeadStarted,
                  resumeReadHead,
                )
              : new MemoryBackend(),
        },
        ttlMs: 1,
        sweepOnAcquire: false,
      });
      const treePath = join(root, "pending-ttl", "trees", "alice");
      const metaPath = join(root, "pending-ttl", "meta", "alice.json");
      mkdirSync(treePath, { recursive: true });
      mkdirSync(join(root, "pending-ttl", "meta"), { recursive: true });
      writeFileSync(join(treePath, "old.txt"), "old");
      writeFileSync(
        metaPath,
        JSON.stringify({
          sandboxId: "alice",
          lastBootedHead: null,
          treeClean: false,
          lastActiveAt: Date.now() - 60_000,
          createdAt: Date.now() - 60_000,
        }),
      );

      const aliceAcquire = pendingMgr.acquire("alice");
      let alice: SandboxHandle | undefined;
      try {
        await readHeadStarted.promise;

        const evicted = await pendingMgr.sweep();
        expect(evicted).not.toContain("alice");
        expect(existsSync(treePath)).toBe(true);
      } finally {
        resumeReadHead.resolve();
        alice = await aliceAcquire.catch(() => undefined);
        await alice?.release();
        await pendingMgr.close();
      }
    });

    it("disk-budget sweep does not evict a sandbox while acquire is pending", async () => {
      const readHeadStarted = deferred();
      const resumeReadHead = deferred();
      const pendingMgr = new WorkspaceManager({
        root: join(root, "pending-budget"),
        defaults: {
          backendFactory: (id) =>
            id === "alice"
              ? backendWithBlockedFirstReadHead(
                  new MemoryBackend(),
                  readHeadStarted,
                  resumeReadHead,
                )
              : new MemoryBackend(),
        },
        ttlMs: 0,
        maxDiskBytes: 1,
        sweepOnAcquire: false,
      });
      const treePath = join(root, "pending-budget", "trees", "alice");
      mkdirSync(treePath, { recursive: true });
      writeFileSync(join(treePath, "large.txt"), "x".repeat(1024));

      const aliceAcquire = pendingMgr.acquire("alice");
      let alice: SandboxHandle | undefined;
      try {
        await readHeadStarted.promise;

        const evicted = await pendingMgr.sweep();
        expect(evicted).not.toContain("alice");
        expect(existsSync(treePath)).toBe(true);
      } finally {
        resumeReadHead.resolve();
        alice = await aliceAcquire.catch(() => undefined);
        await alice?.release();
        await pendingMgr.close();
      }
    });
  });

  describe("escape prevention", () => {
    it("writes inside a sandbox cannot reach another sandbox", async () => {
      const a = await manager.acquire("alice");
      const b = await manager.acquire("bob");
      const bobTree = b.treePath;
      await b.release();

      // Try escaping from alice's tree to bob's
      // (this should always fail because DiskWorkingTree rejects '..')
      await expect(a.fs.writeFile("/../bob/leaked.txt", "pwned")).rejects.toThrow();
      expect(existsSync(join(bobTree, "leaked.txt"))).toBe(false);
      await a.release();
    });
  });
});
