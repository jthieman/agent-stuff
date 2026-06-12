import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DiskWorkingTree } from "../src/disk/disk-working-tree.ts";
import { PersistentFs } from "../src/wrappers/persistent-fs.ts";
import { MemoryBackend } from "../src/stores/memory.ts";

// Mirror the InMemoryFs-backed PersistentFs tests, swapping the inner.
// If these all pass, DiskWorkingTree is a correct drop-in.

describe("PersistentFs with DiskWorkingTree inner", () => {
  let tmpDir: string;
  let treePath: string;
  let backend: MemoryBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "just-stash-disk-test-"));
    treePath = join(tmpDir, "tree");
    require("node:fs").mkdirSync(treePath, { recursive: true });
    backend = new MemoryBackend();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeFs = () => new PersistentFs(new DiskWorkingTree({ root: treePath }), { backend });

  it("boot on empty backend leaves tree empty", async () => {
    const fs = makeFs();
    await fs.boot();
    expect(await fs.readdir("/")).toEqual([]);
  });

  it("commit then re-boot restores files", async () => {
    const fs1 = makeFs();
    await fs1.boot();
    await fs1.writeFile("/app.ts", "export const x = 42;");
    await fs1.mkdir("/data", { recursive: true });
    await fs1.writeFile("/data/notes.md", "# Notes");
    const info = await fs1.commit({ trigger: "turn_end" });
    expect(info.parentId).toBeNull();

    // Use a fresh tree dir to simulate a new container
    const treePath2 = join(tmpDir, "tree2");
    require("node:fs").mkdirSync(treePath2);
    const fs2 = new PersistentFs(new DiskWorkingTree({ root: treePath2 }), { backend });
    await fs2.boot();
    expect(await fs2.readFile("/app.ts")).toBe("export const x = 42;");
    expect(await fs2.readFile("/data/notes.md")).toBe("# Notes");
  });

  it("multiple commits chain via parentId", async () => {
    const fs = makeFs();
    await fs.boot();
    await fs.writeFile("/v.txt", "v1");
    const c1 = await fs.commit({ trigger: "turn_end" });
    await fs.writeFile("/v.txt", "v2");
    const c2 = await fs.commit({ trigger: "turn_end" });
    expect(c2.parentId).toBe(c1.snapshotId);
  });

  it("boot clears existing tree before restoring", async () => {
    const fs = makeFs();
    await fs.boot();
    await fs.writeFile("/keep.txt", "keep");
    await fs.commit({ trigger: "turn_end" });
    // Add stale files
    await fs.writeFile("/stale.txt", "should disappear");
    await fs.boot();
    expect(await fs.exists("/keep.txt")).toBe(true);
    expect(await fs.exists("/stale.txt")).toBe(false);
  });

  it("excludeFromSnapshots: scratch persists locally but not in snapshot", async () => {
    const fs = new PersistentFs(new DiskWorkingTree({ root: treePath }), {
      backend,
      excludeFromSnapshots: ["/scratch"],
    });
    await fs.boot();
    await fs.writeFile("/keep.txt", "persisted");
    await fs.mkdir("/scratch", { recursive: true });
    await fs.writeFile("/scratch/tmp.txt", "transient");
    await fs.commit({ trigger: "turn_end" });

    const fresh = join(tmpDir, "tree2");
    require("node:fs").mkdirSync(fresh);
    const fs2 = new PersistentFs(new DiskWorkingTree({ root: fresh }), {
      backend,
      excludeFromSnapshots: ["/scratch"],
    });
    await fs2.boot();
    expect(await fs2.exists("/keep.txt")).toBe(true);
    expect(await fs2.exists("/scratch/tmp.txt")).toBe(false);
  });

  it("rollback restores prior snapshot to disk", async () => {
    const fs = makeFs();
    await fs.boot();
    await fs.writeFile("/v.txt", "v1");
    const c1 = await fs.commit({ trigger: "turn_end" });
    await fs.writeFile("/v.txt", "v2");
    await fs.commit({ trigger: "turn_end" });
    await fs.rollback(c1.snapshotId);
    expect(await fs.readFile("/v.txt")).toBe("v1");
  });

  it("diff reports added/modified/removed", async () => {
    const fs = makeFs();
    await fs.boot();
    await fs.writeFile("/keep.txt", "same");
    await fs.writeFile("/mod.txt", "before");
    await fs.writeFile("/del.txt", "doomed");
    const c1 = await fs.commit({ trigger: "turn_end" });

    await fs.writeFile("/mod.txt", "after");
    await fs.rm("/del.txt");
    await fs.writeFile("/new.txt", "fresh");
    const c2 = await fs.commit({ trigger: "turn_end" });

    const changes = await fs.diff(c1.snapshotId, c2.snapshotId);
    const byPath = new Map(changes.map((c) => [c.path, c.kind]));
    expect(byPath.get("/new.txt")).toBe("added");
    expect(byPath.get("/del.txt")).toBe("removed");
    expect(byPath.get("/mod.txt")).toBe("modified");
    expect(byPath.has("/keep.txt")).toBe(false);
  });

  it("binary content survives round-trip", async () => {
    const fs = makeFs();
    await fs.boot();
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    await fs.writeFile("/binary.bin", bytes);
    await fs.commit({ trigger: "turn_end" });

    const fresh = join(tmpDir, "tree2");
    require("node:fs").mkdirSync(fresh);
    const fs2 = new PersistentFs(new DiskWorkingTree({ root: fresh }), { backend });
    await fs2.boot();
    const restored = await fs2.readFileBuffer("/binary.bin");
    expect(Buffer.from(restored).equals(Buffer.from(bytes))).toBe(true);
  });
});
