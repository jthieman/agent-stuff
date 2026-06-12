import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fs, {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  utimesSync,
  mkdirSync,
} from "node:fs";
import type { PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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

function findDeadPid(): number {
  let pid = 999_999;
  while (true) {
    try {
      process.kill(pid, 0);
      pid++;
    } catch {
      return pid;
    }
    if (pid > 999_999_999) throw new Error("no dead PID found");
  }
}

describe("WorkspaceManager cross-process locks", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "just-stash-lock-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const mgr = () =>
    new WorkspaceManager({
      root,
      defaults: { backendFactory: () => new MemoryBackend() },
      crossProcessLocking: true, // explicit: this suite tests the file-lock behavior
    });

  it("a second in-process acquire of the same sandbox throws", async () => {
    const m = mgr();
    const h1 = await m.acquire("alice");
    await expect(m.acquire("alice")).rejects.toBeInstanceOf(SandboxLockedError);
    await h1.release();
    await m.close();
  });

  it("after release, the lockfile is gone (or stealable)", async () => {
    const m = mgr();
    const h = await m.acquire("alice");
    const lockPath = join(root, "locks", "alice.lock");
    expect(existsSync(lockPath)).toBe(true);
    await h.release();
    // After release, either the file is deleted OR another acquire works.
    expect(existsSync(lockPath)).toBe(false);
    const h2 = await m.acquire("alice");
    await h2.release();
    await m.close();
  });

  it("lockfile contents include this process PID", async () => {
    const m = mgr();
    const h = await m.acquire("alice");
    const lockPath = join(root, "locks", "alice.lock");
    const content = readFileSync(lockPath, "utf8");
    expect(content).toContain(String(process.pid));
    await h.release();
    await m.close();
  });

  it("stale lockfile (old mtime, dead PID) is reclaimable", async () => {
    // Construct a stale lockfile manually: PID 1 (init — always alive
    // but unsignallable from non-root; alternatively use a clearly-dead
    // PID. Use 99999 which is unlikely to exist.)
    const lockPath = join(root, "locks", "alice.lock");
    const locksDir = join(root, "locks");
    mkdirSync(locksDir, { recursive: true });
    const deadPid = findDeadPid();

    writeFileSync(lockPath, `${deadPid}\nfake-nonce\n${Date.now() - 1000_000}\n`);
    // Backdate mtime to be well past TTL
    const oldTime = new Date(Date.now() - 300_000); // 5 min ago
    utimesSync(lockPath, oldTime, oldTime);

    // Now acquire — should succeed by reclaiming
    const m = mgr();
    const h = await m.acquire("alice");
    // The lockfile should now contain OUR pid
    const content = readFileSync(lockPath, "utf8");
    expect(content).toContain(String(process.pid));
    expect(content).not.toContain(String(deadPid));
    await h.release();
    await m.close();
  });

  it("stale lock reclaim cannot delete another reclaimer's fresh lock", async () => {
    const lockPath = join(root, "locks", "alice.lock");
    mkdirSync(join(root, "locks"), { recursive: true });
    const deadPid = findDeadPid();
    writeFileSync(lockPath, `${deadPid}\nfake-nonce\n${Date.now() - 300_000}\n`);
    const oldTime = new Date(Date.now() - 300_000);
    utimesSync(lockPath, oldTime, oldTime);

    const secondReclaimerReady = deferred();
    const firstHolderReady = deferred();
    const originalUnlink = fs.promises.unlink;
    let lockPathReclaimUnlinks = 0;

    fs.promises.unlink = (async (path: PathLike): Promise<void> => {
      if (
        String(path) === lockPath &&
        !existsSync(`${lockPath}.reclaim`) &&
        lockPathReclaimUnlinks < 2
      ) {
        lockPathReclaimUnlinks++;
        if (lockPathReclaimUnlinks === 1) {
          await secondReclaimerReady.promise;
          return originalUnlink(path);
        }
        secondReclaimerReady.resolve();
        await firstHolderReady.promise;
        return originalUnlink(path);
      }
      return originalUnlink(path);
    }) as typeof fs.promises.unlink;
    syncBuiltinESMExports();

    const m1 = mgr();
    const m2 = mgr();
    let handles: SandboxHandle[] = [];
    try {
      const acquire1 = m1.acquire("alice").then((handle) => {
        firstHolderReady.resolve();
        return handle;
      });
      const acquire2 = m2.acquire("alice").then((handle) => {
        firstHolderReady.resolve();
        return handle;
      });

      const results = await Promise.allSettled([acquire1, acquire2]);
      const rejected: PromiseRejectedResult[] = [];
      for (const result of results) {
        if (result.status === "fulfilled") {
          handles.push(result.value);
        } else {
          rejected.push(result);
        }
      }

      expect(handles.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect(rejected[0].reason).toBeInstanceOf(SandboxLockedError);
    } finally {
      fs.promises.unlink = originalUnlink;
      syncBuiltinESMExports();
      for (const handle of handles) {
        await handle.release();
      }
      await m1.close();
      await m2.close();
    }
  });

  it("fresh lockfile (recent mtime) cannot be stolen", async () => {
    const lockPath = join(root, "locks", "alice.lock");
    mkdirSync(join(root, "locks"), { recursive: true });
    // Pretend another process holds it with a recent timestamp
    writeFileSync(lockPath, `${process.pid}\nother-nonce\n${Date.now()}\n`);
    // mtime is naturally fresh

    const m = mgr();
    // PID matches us → "process alive" → SandboxLockedError
    await expect(m.acquire("alice")).rejects.toBeInstanceOf(SandboxLockedError);
    await m.close();
  });

  it("in-process race: concurrent acquire() calls produce exactly one winner", async () => {
    const m = mgr();
    // Fire two acquires in parallel; the second must fail synchronously
    // before any await yields. With the `pending` set, this is rejected
    // by the in-process check, not by the file lock.
    const a = m.acquire("alice");
    const b = m.acquire("alice");
    const results = await Promise.allSettled([a, b]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(bad.length).toBe(1);
    expect((bad[0] as PromiseRejectedResult).reason).toBeInstanceOf(SandboxLockedError);
    // Clean up the winner
    if (ok[0].status === "fulfilled") {
      await (ok[0].value as any).release();
    }
    await m.close();
  });
});

describe("WorkspaceManager with crossProcessLocking disabled", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "just-stash-nolock-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const mgr = () =>
    new WorkspaceManager({
      root,
      defaults: { backendFactory: () => new MemoryBackend() },
      crossProcessLocking: false,
    });

  it("no lockfile is created on acquire", async () => {
    const m = mgr();
    const h = await m.acquire("alice");
    const lockPath = join(root, "locks", "alice.lock");
    expect(existsSync(lockPath)).toBe(false);
    await h.release();
    await m.close();
  });

  it("release works without a lockfile", async () => {
    const m = mgr();
    const h = await m.acquire("alice");
    await h.release(); // should not throw
    const h2 = await m.acquire("alice");
    await h2.release();
    await m.close();
  });

  it("in-process race protection STILL works without the lockfile", async () => {
    const m = mgr();
    const a = m.acquire("alice");
    const b = m.acquire("alice");
    const results = await Promise.allSettled([a, b]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(bad.length).toBe(1);
    expect((bad[0] as PromiseRejectedResult).reason).toBeInstanceOf(SandboxLockedError);
    if (ok[0].status === "fulfilled") {
      await (ok[0].value as any).release();
    }
    await m.close();
  });

  it("sequential acquires still serialize via the active map", async () => {
    const m = mgr();
    const h1 = await m.acquire("alice");
    // Second acquire (while first held) must fail
    await expect(m.acquire("alice")).rejects.toBeInstanceOf(SandboxLockedError);
    await h1.release();
    // After release, succeeds
    const h2 = await m.acquire("alice");
    await h2.release();
    await m.close();
  });

  it("eviction still works without lockfile", async () => {
    const m = mgr();
    const h = await m.acquire("alice");
    const treePath = h.treePath;
    await h.release();
    await m.evict("alice");
    expect(existsSync(treePath)).toBe(false);
    await m.close();
  });
});

describe("WorkspaceManager events", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "just-stash-events-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("emits acquire with warmBoot info", async () => {
    const m = new WorkspaceManager({
      root,
      defaults: { backendFactory: () => new MemoryBackend() },
    });
    const events: Array<{ sandboxId: string; warmBoot: boolean }> = [];
    m.on("acquire", (sandboxId, info) => events.push({ sandboxId, ...info }));

    const h1 = await m.acquire("alice");
    expect(events).toEqual([{ sandboxId: "alice", warmBoot: false }]);
    await h1.release();
    await m.close();
  });

  it("emits release", async () => {
    const m = new WorkspaceManager({
      root,
      defaults: { backendFactory: () => new MemoryBackend() },
    });
    const released: string[] = [];
    m.on("release", (id) => released.push(id));
    const h = await m.acquire("bob");
    await h.release();
    expect(released).toEqual(["bob"]);
    await m.close();
  });

  it("emits evict with reason", async () => {
    const m = new WorkspaceManager({
      root,
      defaults: { backendFactory: () => new MemoryBackend() },
    });
    const evicts: Array<{ id: string; reason: string }> = [];
    m.on("evict", (id, info) => evicts.push({ id, reason: info.reason }));
    const h = await m.acquire("charlie");
    await h.release();
    await m.evict("charlie");
    expect(evicts).toEqual([{ id: "charlie", reason: "explicit" }]);
    await m.close();
  });

  it("emits sweep with stats", async () => {
    const m = new WorkspaceManager({
      root,
      defaults: { backendFactory: () => new MemoryBackend() },
      ttlMs: 0,
      sweepOnAcquire: false,
    });
    const sweeps: Array<{ scanned: number; evicted: string[] }> = [];
    m.on("sweep", (info) => sweeps.push(info));
    await m.sweep();
    expect(sweeps.length).toBe(1);
    await m.close();
  });
});
