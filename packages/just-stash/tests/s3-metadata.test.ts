import { describe, it, expect, beforeEach } from "vite-plus/test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { S3MetadataStore } from "../src/stores/s3-metadata.ts";
import { S3BlobStore } from "../src/stores/s3.ts";
import { CasConflictError } from "../src/types.ts";

// We can't reach real S3 from this sandbox, so we model the relevant
// subset of S3's behavior: object PUT with optional If-Match / If-None-Match
// preconditions, GET returns body + ETag. This is the exact slice
// S3MetadataStore depends on.
//
// Real-S3 integration tests live elsewhere (Docker Compose + MinIO).
class FakeS3Client {
  private objects = new Map<string, { body: Buffer; etag: string }>();
  destroyed = false;

  async send(cmd: any): Promise<any> {
    const name = cmd?.constructor?.name;
    const input = cmd.input;
    switch (name) {
      case "GetObjectCommand":
        return this.handleGet(input);
      case "PutObjectCommand":
        return this.handlePut(input);
      case "DeleteObjectCommand":
        return this.handleDelete(input);
      case "ListObjectsV2Command":
        return this.handleList(input);
      default:
        throw new Error(`unhandled command: ${name}`);
    }
  }

  destroy() {
    this.destroyed = true;
  }

  // ---

  private handleGet(input: { Bucket: string; Key: string }): any {
    const obj = this.objects.get(input.Key);
    if (!obj) {
      const e: any = new Error("NoSuchKey");
      e.name = "NoSuchKey";
      e.$metadata = { httpStatusCode: 404 };
      throw e;
    }
    return {
      Body: Readable.from([obj.body]),
      ETag: obj.etag,
    };
  }

  private handlePut(input: {
    Bucket: string;
    Key: string;
    Body: any;
    IfMatch?: string;
    IfNoneMatch?: string;
  }): any {
    const existing = this.objects.get(input.Key);
    // If-None-Match: "*" → succeed only if missing
    if (input.IfNoneMatch === "*" && existing) {
      throw preconditionFailed();
    }
    // If-Match: <etag> → succeed only if existing.etag === input.IfMatch
    if (input.IfMatch !== undefined) {
      if (!existing || existing.etag !== input.IfMatch) {
        throw preconditionFailed();
      }
    }
    const body = toBuffer(input.Body);
    const etag = `"${createHash("md5").update(body).digest("hex")}"`;
    this.objects.set(input.Key, { body, etag });
    return { ETag: etag };
  }

  private handleDelete(input: { Bucket: string; Key: string }): any {
    this.objects.delete(input.Key);
    return {};
  }

  private handleList(input: { Bucket: string; Prefix?: string; ContinuationToken?: string }): any {
    const prefix = input.Prefix ?? "";
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    return {
      Contents: keys.map((Key) => ({ Key })),
      IsTruncated: false,
      NextContinuationToken: undefined,
    };
  }

  // Test helpers
  size(): number {
    return this.objects.size;
  }
  has(key: string): boolean {
    return this.objects.has(key);
  }
  getRaw(key: string): { body: Buffer; etag: string } | undefined {
    return this.objects.get(key);
  }
  /** Force-mutate an object outside the store (simulates another process). */
  forceSet(key: string, body: string | Buffer): void {
    const buf = toBuffer(body);
    const etag = `"${createHash("md5").update(buf).digest("hex")}"`;
    this.objects.set(key, { body: buf, etag });
  }
}

function preconditionFailed(): Error {
  const e: any = new Error("PreconditionFailed");
  e.name = "PreconditionFailed";
  e.$metadata = { httpStatusCode: 412 };
  return e;
}

function toBuffer(body: any): Buffer {
  if (typeof body === "string") return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new Error(`unhandled body type: ${typeof body}`);
}

// =====================================================================
// Tests
// =====================================================================

describe("S3MetadataStore (via fake S3 client)", () => {
  let s3: FakeS3Client;
  let store: S3MetadataStore;

  beforeEach(async () => {
    s3 = new FakeS3Client();
    store = new S3MetadataStore({
      bucket: "test",
      s3Client: s3 as any,
    });
    await store.initialize();
  });

  describe("initialization", () => {
    it("creates HEAD as null on first init", async () => {
      expect(await store.readHead()).toBeNull();
      // The HEAD object exists with the sentinel
      expect(s3.has("metadata/HEAD")).toBe(true);
    });

    it("initialize is idempotent (race-safe via If-None-Match)", async () => {
      // Simulate two processes initializing concurrently
      const store2 = new S3MetadataStore({
        bucket: "test",
        s3Client: s3 as any,
      });
      await store2.initialize();
      // Should not throw, HEAD should still be null
      expect(await store.readHead()).toBeNull();
    });
  });

  describe("appendCommit", () => {
    it("first commit succeeds, HEAD advances", async () => {
      const commit = {
        snapshotId: "sha1" as any,
        contentId: "blob1" as any,
        parentId: null,
        trigger: "first",
        message: "first",
        author: { name: "a", email: "a@b" },
        timestamp: 1000,
      };
      await store.appendCommit({ commit, priorHead: null });
      expect(await store.readHead()).toBe("sha1");
      expect((await store.getCommit("sha1" as any))?.contentId).toBe("blob1");
    });

    it("second commit chains via parentId", async () => {
      await store.appendCommit({
        commit: {
          snapshotId: "sha1" as any,
          parentId: null,
          trigger: "first",
          message: "first",
          author: { name: "a", email: "a@b" },
          timestamp: 1000,
        },
        priorHead: null,
      });
      await store.appendCommit({
        commit: {
          snapshotId: "sha2" as any,
          parentId: "sha1" as any,
          trigger: "second",
          message: "second",
          author: { name: "a", email: "a@b" },
          timestamp: 2000,
        },
        priorHead: "sha1" as any,
      });
      expect(await store.readHead()).toBe("sha2");
    });

    it("CAS conflict: priorHead mismatch (stale read)", async () => {
      // First commit
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
      // Try to commit with stale priorHead (null instead of sha1)
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
          priorHead: null, // WRONG — HEAD is sha1 now
        }),
      ).rejects.toBeInstanceOf(CasConflictError);
    });

    it("CAS conflict: HEAD changed under us between read and write (true race)", async () => {
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

      // Simulate another process writing HEAD = sha3 while we think
      // it's still sha1. Done by force-setting the HEAD object outside
      // our store, which changes its etag.
      s3.forceSet("metadata/HEAD", "sha3");

      await expect(
        store.appendCommit({
          commit: {
            snapshotId: "sha2" as any,
            parentId: "sha1" as any,
            trigger: "t",
            message: "m",
            author: { name: "a", email: "a@b" },
            timestamp: 2000,
          },
          priorHead: "sha1" as any, // we still think this
        }),
      ).rejects.toBeInstanceOf(CasConflictError);

      // HEAD should still be sha3 (the other writer's value)
      expect(await store.readHead()).toBe("sha3");
    });

    it("pre-flight CAS check: commit object NOT written when priorHead is stale", async () => {
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
      // Force HEAD swap to invalidate our prior
      s3.forceSet("metadata/HEAD", "shaX");

      try {
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
      } catch {
        /* expected */
      }

      // The pre-flight check sees HEAD=shaX, priorHead=sha1 → throw BEFORE
      // writing the commit object. No orphan in this (common) case.
      expect(await store.getCommit("sha2" as any)).toBeNull();
    });
  });

  describe("setHead (rollback)", () => {
    it("rolls back HEAD to a known commit", async () => {
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
      await store.setHead("sha1" as any, "sha2" as any);
      expect(await store.readHead()).toBe("sha1");
    });

    it("refuses to set HEAD to an unknown commit", async () => {
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
      await expect(store.setHead("phantom" as any, "sha1" as any)).rejects.toThrow(
        "unknown commit",
      );
    });

    it("CAS conflict on setHead", async () => {
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
      // Race: HEAD changes externally
      s3.forceSet("metadata/HEAD", "shaX");
      await expect(store.setHead("sha1" as any, "sha1" as any)).rejects.toBeInstanceOf(
        CasConflictError,
      );
    });
  });

  describe("log", () => {
    it("walks chain newest-first", async () => {
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

    it("respects limit", async () => {
      for (let i = 0; i < 5; i++) {
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
      const log = await store.log({ limit: 2 });
      expect(log.length).toBe(2);
    });

    it("returns the full chain when limit is omitted", async () => {
      for (let i = 0; i < 105; i++) {
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
      expect(log).toHaveLength(105);
      expect(log[0].snapshotId).toBe("sha104");
      expect(log[104].snapshotId).toBe("sha0");
    });
  });

  describe("notes", () => {
    it("putNote and getNote round-trip", async () => {
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
      expect(await store.getNote("sha1" as any)).toBe("metadata");
    });

    it("putNote is idempotent (overwrites)", async () => {
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
      await store.putNote("sha1" as any, "first");
      await store.putNote("sha1" as any, "second");
      expect(await store.getNote("sha1" as any)).toBe("second");
    });

    it("getNote returns null for missing", async () => {
      expect(await store.getNote("absent" as any)).toBeNull();
    });
  });

  describe("listCommitIds", () => {
    it("yields all commit ids", async () => {
      for (let i = 0; i < 3; i++) {
        await store.appendCommit({
          commit: {
            snapshotId: `sha${i}` as any,
            parentId: i === 0 ? null : (`sha${i - 1}` as any),
            trigger: "t",
            message: "m",
            author: { name: "a", email: "a@b" },
            timestamp: i,
          },
          priorHead: i === 0 ? null : (`sha${i - 1}` as any),
        });
      }
      const ids: string[] = [];
      for await (const id of store.listCommitIds()) ids.push(id);
      expect(ids.sort()).toEqual(["sha0", "sha1", "sha2"]);
    });
  });

  describe("lifecycle", () => {
    it("maps missing blob objects to the common not-found error", async () => {
      const blobs = new S3BlobStore({ bucket: "test", s3Client: s3 as any });
      const key = "a".repeat(64);

      await expect(blobs.get(key)).rejects.toThrow(`Blob not found: ${key}`);
    });

    it("does not destroy caller-owned S3 clients on close", async () => {
      const blobs = new S3BlobStore({ bucket: "test", s3Client: s3 as any });
      await store.close();
      await blobs.close();
      expect(s3.destroyed).toBe(false);
    });
  });
});
