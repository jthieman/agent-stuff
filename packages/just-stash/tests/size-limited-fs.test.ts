import { describe, it, expect } from "vite-plus/test";
import { InMemoryFs } from "just-bash";
import { SizeLimitedFs } from "../src/wrappers/size-limited-fs.ts";

describe("SizeLimitedFs", () => {
  describe("byte limits", () => {
    it("allows writes under the limit", async () => {
      const fs = new SizeLimitedFs(new InMemoryFs(), { maxBytes: 1000 });
      await fs.writeFile("/a.txt", "hello");
      expect(fs.totalBytes).toBe(5);
    });

    it("rejects writes over the limit", async () => {
      const fs = new SizeLimitedFs(new InMemoryFs(), { maxBytes: 10 });
      await expect(fs.writeFile("/big.txt", "x".repeat(11))).rejects.toThrow("ENOSPC");
    });

    it("overwriting with smaller content frees bytes", async () => {
      const fs = new SizeLimitedFs(new InMemoryFs(), { maxBytes: 20 });
      await fs.writeFile("/a.txt", "x".repeat(15));
      await fs.writeFile("/a.txt", "short");
      expect(fs.totalBytes).toBe(5);
    });
  });

  describe("entry limits", () => {
    it("rejects writes over entry limit", async () => {
      const fs = new SizeLimitedFs(new InMemoryFs(), { maxBytes: 1_000_000, maxEntries: 2 });
      await fs.writeFile("/a.txt", "a");
      await fs.writeFile("/b.txt", "b");
      await expect(fs.writeFile("/c.txt", "c")).rejects.toThrow("ENOSPC");
    });

    it("mkdir counts as an entry", async () => {
      const fs = new SizeLimitedFs(new InMemoryFs(), { maxBytes: 1_000_000, maxEntries: 1 });
      await fs.mkdir("/dir");
      await expect(fs.writeFile("/f.txt", "x")).rejects.toThrow("ENOSPC");
    });

    it("recursive parent directories count toward the entry limit", async () => {
      const fs = new SizeLimitedFs(new InMemoryFs(), { maxBytes: 1_000_000, maxEntries: 2 });
      await expect(fs.writeFile("/a/b/c.txt", "x")).rejects.toThrow("ENOSPC");
    });

    it("nested writes account for created parents and leaf", async () => {
      const fs = new SizeLimitedFs(new InMemoryFs(), { maxBytes: 1_000_000, maxEntries: 3 });
      await fs.writeFile("/a/b/c.txt", "x");
      expect(fs.totalEntries).toBe(3);
    });

    it("symlink and hard link paths count as entries", async () => {
      const fs = new SizeLimitedFs(new InMemoryFs(), { maxBytes: 1_000_000, maxEntries: 2 });
      await fs.writeFile("/file.txt", "x");
      await fs.symlink("/file.txt", "/link.txt");
      await expect(fs.link("/file.txt", "/hardlink.txt")).rejects.toThrow("ENOSPC");
    });
  });

  describe("rename and link accounting", () => {
    it("mv overwrite subtracts the replaced destination from counters", async () => {
      const fs = new SizeLimitedFs(new InMemoryFs(), { maxBytes: 1_000_000, maxEntries: 10 });
      await fs.writeFile("/source.txt", "x".repeat(100));
      await fs.writeFile("/dest.txt", "y".repeat(200));

      await fs.mv("/source.txt", "/dest.txt");

      expect(fs.totalBytes).toBe(100);
      expect(fs.totalEntries).toBe(1);
      expect(await fs.readFile("/dest.txt")).toBe("x".repeat(100));
    });

    it("hard links add entries without double-counting file bytes", async () => {
      const fs = new SizeLimitedFs(new InMemoryFs(), { maxBytes: 200, maxEntries: 2 });
      await fs.writeFile("/file.txt", "x".repeat(200));

      await fs.link("/file.txt", "/hardlink.txt");

      expect(fs.totalBytes).toBe(200);
      expect(fs.totalEntries).toBe(2);
    });
  });

  describe("rm frees", () => {
    it("rm decreases counters", async () => {
      const fs = new SizeLimitedFs(new InMemoryFs(), { maxBytes: 100 });
      await fs.writeFile("/file.txt", "x".repeat(50));
      expect(fs.totalBytes).toBe(50);
      await fs.rm("/file.txt");
      expect(fs.totalBytes).toBe(0);
    });
  });

  describe("recalculate", () => {
    it("resets counters from inner state", async () => {
      const inner = new InMemoryFs({ "/a.txt": "hi", "/b.txt": "there" });
      const fs = new SizeLimitedFs(inner, { maxBytes: 1000 });
      expect(fs.totalBytes).toBe(0);

      await fs.recalculate();
      expect(fs.totalBytes).toBeGreaterThan(0);
      expect(fs.totalEntries).toBeGreaterThan(0);
    });
  });

  describe("passthrough", () => {
    it("reads work", async () => {
      const inner = new InMemoryFs({ "/a.txt": "hi" });
      const fs = new SizeLimitedFs(inner, { maxBytes: 1000 });
      expect(await fs.readFile("/a.txt")).toBe("hi");
    });
  });
});
