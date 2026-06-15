import { describe, it, expect, beforeEach } from "vite-plus/test";
import { InMemoryFs } from "just-bash";
import { FilteredFs } from "../src/index.ts";

describe("FilteredFs", () => {
  let inner: InMemoryFs;

  beforeEach(() => {
    inner = new InMemoryFs({
      "/src/app.ts": "code",
      "/.env": "SECRET=x",
      "/.env.local": "LOCAL=y",
      "/config/key.pem": "pem",
      "/config/app.json": "{}",
      "/README.md": "# hi",
    });
  });

  describe("exclude patterns", () => {
    it("exact segment match hides", async () => {
      const fs = new FilteredFs(inner, { exclude: [".env"] });
      expect(await fs.exists("/.env")).toBe(false);
      expect(await fs.exists("/.env.local")).toBe(true);
    });

    it("glob prefix hides", async () => {
      const fs = new FilteredFs(inner, { exclude: [".env*"] });
      expect(await fs.exists("/.env")).toBe(false);
      expect(await fs.exists("/.env.local")).toBe(false);
    });

    it("glob suffix hides", async () => {
      const fs = new FilteredFs(inner, { exclude: ["*.pem"] });
      expect(await fs.exists("/config/key.pem")).toBe(false);
      expect(await fs.exists("/config/app.json")).toBe(true);
    });
  });

  describe("read operations", () => {
    it("readFile of excluded path throws ENOENT", async () => {
      const fs = new FilteredFs(inner, { exclude: [".env*"] });
      await expect(fs.readFile("/.env")).rejects.toThrow("ENOENT");
    });

    it("stat of excluded path throws ENOENT", async () => {
      const fs = new FilteredFs(inner, { exclude: ["*.pem"] });
      await expect(fs.stat("/config/key.pem")).rejects.toThrow("ENOENT");
    });

    it("visible files read normally", async () => {
      const fs = new FilteredFs(inner, { exclude: [".env*"] });
      expect(await fs.readFile("/README.md")).toBe("# hi");
    });
  });

  describe("write operations", () => {
    it("writeFile to excluded path is blocked", async () => {
      const fs = new FilteredFs(inner, { exclude: [".env*"] });
      await expect(fs.writeFile("/.env.prod", "x")).rejects.toThrow("ENOENT");
    });

    it("writeFile to visible path works", async () => {
      const fs = new FilteredFs(inner, { exclude: [".env*"] });
      await fs.writeFile("/new.txt", "x");
      expect(await fs.readFile("/new.txt")).toBe("x");
    });
  });

  describe("readdir filtering", () => {
    it("readdir omits excluded entries", async () => {
      const fs = new FilteredFs(inner, { exclude: [".env", ".env.local"] });
      const entries = await fs.readdir("/");
      expect(entries).not.toContain(".env");
      expect(entries).not.toContain(".env.local");
      expect(entries).toContain("README.md");
    });

    it("readdirWithFileTypes omits excluded", async () => {
      const fs = new FilteredFs(inner, { exclude: [".env*"] });
      const entries = await fs.readdirWithFileTypes("/");
      const names = entries.map((e) => e.name);
      expect(names).not.toContain(".env");
      expect(names).not.toContain(".env.local");
    });
  });

  describe("custom filter", () => {
    it("filter function hides matching paths", async () => {
      const fs = new FilteredFs(inner, {
        filter: (p) => !p.includes("credentials"),
      });
      expect(await fs.exists("/README.md")).toBe(true);
    });

    it("filter + exclude both apply", async () => {
      const fs = new FilteredFs(inner, {
        exclude: ["*.pem"],
        filter: (p) => !p.includes(".env"),
      });
      expect(await fs.exists("/.env")).toBe(false);
      expect(await fs.exists("/config/key.pem")).toBe(false);
      expect(await fs.exists("/src/app.ts")).toBe(true);
    });
  });

  describe("rm", () => {
    it("rm of excluded path with force is no-op", async () => {
      const fs = new FilteredFs(inner, { exclude: [".env"] });
      await fs.rm("/.env", { force: true });
      expect(await inner.exists("/.env")).toBe(true);
    });

    it("rm of excluded path without force throws", async () => {
      const fs = new FilteredFs(inner, { exclude: [".env"] });
      await expect(fs.rm("/.env")).rejects.toThrow("ENOENT");
    });
  });

  describe("empty filter is passthrough", () => {
    it("no patterns + no filter = all visible", async () => {
      const fs = new FilteredFs(inner, {});
      expect(await fs.exists("/.env")).toBe(true);
      expect(await fs.exists("/config/key.pem")).toBe(true);
    });
  });

  describe("symlink boundaries", () => {
    it("blocks creating a visible symlink to an excluded target", async () => {
      const fs = new FilteredFs(inner, { exclude: [".env*"] });
      await expect(fs.symlink("/.env", "/visible-link")).rejects.toThrow("ENOENT");
    });

    it("hides existing visible symlinks that resolve to excluded targets", async () => {
      await inner.symlink("/.env", "/visible-link");
      const fs = new FilteredFs(inner, { exclude: [".env*"] });
      expect(await fs.exists("/visible-link")).toBe(false);
      await expect(fs.readFile("/visible-link")).rejects.toThrow("ENOENT");
    });

    it("blocks writes through visible parent symlinks to excluded targets", async () => {
      await inner.mkdir("/hidden", { recursive: true });
      await inner.symlink("/hidden", "/visible-dir");
      const fs = new FilteredFs(inner, { exclude: ["hidden"] });
      await expect(fs.writeFile("/visible-dir/new.txt", "x")).rejects.toThrow("ENOENT");
    });
  });

  describe("subtree copy and move boundaries", () => {
    it("blocks copying a visible directory that contains path-filtered descendants", async () => {
      await inner.writeFile("/src/hidden.txt", "secret");
      const fs = new FilteredFs(inner, {
        filter: (p) => !p.startsWith("/src/hidden"),
      });

      await expect(fs.cp("/src", "/copy", { recursive: true })).rejects.toThrow("ENOENT");
      expect(await inner.exists("/copy/hidden.txt")).toBe(false);
    });

    it("blocks moving a visible directory that contains path-filtered descendants", async () => {
      await inner.writeFile("/src/hidden.txt", "secret");
      const fs = new FilteredFs(inner, {
        filter: (p) => !p.startsWith("/src/hidden"),
      });

      await expect(fs.mv("/src", "/moved")).rejects.toThrow("ENOENT");
      expect(await inner.exists("/moved/hidden.txt")).toBe(false);
      expect(await inner.exists("/src/app.ts")).toBe(true);
    });
  });

  describe("getAllPaths filters", () => {
    it("returns only non-excluded paths", () => {
      const fs = new FilteredFs(inner, { exclude: [".env*", "*.pem"] });
      const paths = fs.getAllPaths();
      expect(paths).not.toContain("/.env");
      expect(paths).not.toContain("/config/key.pem");
      expect(paths).toContain("/README.md");
    });
  });
});
