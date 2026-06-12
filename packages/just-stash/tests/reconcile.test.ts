import { describe, it, expect } from "vite-plus/test";
import { InMemoryFs } from "just-bash";
import { PersistentFs } from "../src/wrappers/persistent-fs.ts";
import { MemoryBackend } from "../src/stores/memory.ts";
import { CasConflictError } from "../src/types.ts";

describe("PersistentFs.reconcile", () => {
  it("translates CasConflictError to a structured outcome", async () => {
    const backend = new MemoryBackend();
    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();

    // Seed one commit so HEAD isn't null
    await fs.writeFile("/seed.txt", "seed");
    await fs.commit({ trigger: "seed" });
    const realHead = await backend.readHead();

    // Force a CAS conflict by calling backend.commit directly with
    // a deliberately-stale priorHead.
    try {
      await backend.commit({
        fs: new InMemoryFs(),
        excludePaths: [],
        priorHead: null, // STALE — actual HEAD is realHead
        metadata: {
          trigger: "t",
          message: "m",
          author: { name: "x", email: "x@y" },
          timestamp: Date.now(),
        },
      });
      expect.fail("should have thrown CasConflictError");
    } catch (e) {
      // Confirm the error itself
      expect(e).toBeInstanceOf(CasConflictError);
      // Now reconcile
      const outcome = await fs.reconcile(e);
      expect(outcome.kind).toBe("conflict");
      if (outcome.kind === "conflict") {
        expect(outcome.actualHead).toBe(realHead);
      }
    }
  });

  it("returns observed when the error is not a CAS conflict", async () => {
    // We don't have an easy way to inject non-CAS errors against MemoryBackend
    // without mocks, so just verify the shape with a synthetic error.
    const backend = new MemoryBackend();
    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();
    await fs.writeFile("/x.txt", "hello");
    const info = await fs.commit({ trigger: "first" });

    // A random Error (not CasConflictError)
    const outcome = await fs.reconcile(new Error("network unreachable"));
    expect(outcome.kind).toBe("observed");
    if (outcome.kind === "observed") {
      expect(outcome.currentHead).toBe(info.snapshotId);
    }
  });

  it('caller can distinguish "actually landed" via head comparison', async () => {
    // Simulating the scenario: commit appeared to fail, but actually
    // landed. Reconcile + caller-side comparison.
    const backend = new MemoryBackend();
    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();
    await fs.writeFile("/x.txt", "v1");
    await fs.commit({ trigger: "first" });
    const priorHead = await backend.readHead();

    // Make a change and commit; capture HEAD
    await fs.writeFile("/x.txt", "v2");
    const info = await fs.commit({ trigger: "second" });

    // Now simulate: caller doesn't know if the commit succeeded
    // (pretend they caught an error). They call reconcile.
    const outcome = await fs.reconcile(new Error("lost contact"));
    expect(outcome.kind).toBe("observed");
    if (outcome.kind === "observed") {
      // The caller compares: head changed since priorHead?
      expect(outcome.currentHead).not.toBe(priorHead);
      // Yes — so their commit might have landed. They can now
      // walk log() to find a commit whose tree matches what they
      // intended, confirming.
      expect(outcome.currentHead).toBe(info.snapshotId);
    }
  });
});
