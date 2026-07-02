/**
 * Integration tests against MinIO (S3-compatible) via testcontainers.
 *
 * Requires Docker.
 *
 *   vp test run s3.integration
 *
 * What these tests prove that the in-memory fake can't:
 *   - The exact API shape of S3Client commands works against a real
 *     S3-compatible server (PUT with IfMatch/IfNoneMatch, GET, DELETE,
 *     ListObjectsV2)
 *   - 412 PreconditionFailed comes back in the shape S3MetadataStore
 *     expects (the error name, httpStatusCode location)
 *   - End-to-end commit/rollback against a real network round-trip
 *   - ListObjectsV2 pagination handles many objects
 *   - Conditional writes serialize concurrent CAS attempts correctly
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { S3BlobStore } from "../src/stores/s3.ts";
import { S3MetadataStore } from "../src/stores/s3-metadata.ts";
import { BlobBackend } from "../src/index.ts";
import { PersistentFs } from "../src/wrappers/persistent-fs.ts";
import { CasConflictError } from "../src/types.ts";
import { InMemoryFs } from "just-bash";
import { findOrphanBlobs, pruneOrphanBlobs, verifyIntegrity } from "../src/doctor.ts";

const BUCKET = "just-stash-test";

describe("S3 / MinIO integration", () => {
  let container: StartedTestContainer;
  let s3: S3Client;
  let endpoint: string;

  beforeAll(async () => {
    container = await new GenericContainer("minio/minio:latest")
      .withEnvironment({
        MINIO_ROOT_USER: "minioadmin",
        MINIO_ROOT_PASSWORD: "minioadmin",
      })
      .withCommand(["server", "/data"])
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forLogMessage(/API: http/, 1))
      .withStartupTimeout(60_000)
      .start();

    endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;

    s3 = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: "minioadmin",
        secretAccessKey: "minioadmin",
      },
    });

    // Create the bucket
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    }
  }, 120_000);

  afterAll(async () => {
    s3?.destroy();
    await container?.stop();
  }, 30_000);

  describe("S3BlobStore", () => {
    it("put + exists + get round-trip", async () => {
      const blobs = new S3BlobStore({ bucket: BUCKET, s3Client: s3 });
      const content = Buffer.from("hello s3 world");
      const key = await blobs.put(content);
      expect(await blobs.exists(key)).toBe(true);
      const back = await blobs.get(key);
      expect(back.toString("utf8")).toBe("hello s3 world");
    });

    it("put is idempotent via If-None-Match (same content = same key)", async () => {
      const blobs = new S3BlobStore({ bucket: BUCKET, s3Client: s3 });
      const content = Buffer.from("idempotent-put-content");
      const k1 = await blobs.put(content);
      const k2 = await blobs.put(content); // should not throw
      expect(k1).toBe(k2);
    });

    it("list returns all blob keys", async () => {
      const blobs = new S3BlobStore({
        bucket: BUCKET,
        s3Client: s3,
        prefix: "list-test/",
      });
      const c1 = await blobs.put(Buffer.from("list-1"));
      const c2 = await blobs.put(Buffer.from("list-2"));
      const c3 = await blobs.put(Buffer.from("list-3"));

      const seen: string[] = [];
      for await (const key of blobs.list()) seen.push(key);
      expect(seen.sort()).toEqual([c1, c2, c3].sort());
    });
  });

  describe("S3MetadataStore", () => {
    it("initialize creates HEAD with null sentinel", async () => {
      const store = new S3MetadataStore({
        bucket: BUCKET,
        s3Client: s3,
        prefix: "meta-init/",
      });
      await store.initialize();
      expect(await store.readHead()).toBeNull();
      // Re-initialize is idempotent
      await store.initialize();
      expect(await store.readHead()).toBeNull();
    });

    it("appendCommit advances HEAD via If-Match etag", async () => {
      const store = new S3MetadataStore({
        bucket: BUCKET,
        s3Client: s3,
        prefix: "meta-append/",
      });
      await store.initialize();

      await store.appendCommit({
        commit: {
          snapshotId: "sha-1" as any,
          parentId: null,
          trigger: "t",
          message: "first",
          author: { name: "a", email: "a@a" },
          timestamp: 1000,
        },
        priorHead: null,
      });
      expect(await store.readHead()).toBe("sha-1");

      await store.appendCommit({
        commit: {
          snapshotId: "sha-2" as any,
          parentId: "sha-1" as any,
          trigger: "t",
          message: "second",
          author: { name: "a", email: "a@a" },
          timestamp: 2000,
        },
        priorHead: "sha-1" as any,
      });
      expect(await store.readHead()).toBe("sha-2");
    });

    it("CAS conflict: stale priorHead is detected", async () => {
      const store = new S3MetadataStore({
        bucket: BUCKET,
        s3Client: s3,
        prefix: "meta-cas/",
      });
      await store.initialize();

      await store.appendCommit({
        commit: {
          snapshotId: "cas-1" as any,
          parentId: null,
          trigger: "t",
          message: "first",
          author: { name: "a", email: "a@a" },
          timestamp: 1000,
        },
        priorHead: null,
      });

      await expect(
        store.appendCommit({
          commit: {
            snapshotId: "cas-2" as any,
            parentId: null,
            trigger: "t",
            message: "duplicate",
            author: { name: "a", email: "a@a" },
            timestamp: 2000,
          },
          priorHead: null, // STALE — actual HEAD is cas-1
        }),
      ).rejects.toBeInstanceOf(CasConflictError);
    });

    it("CAS conflict: concurrent writers, real network race", async () => {
      const store = new S3MetadataStore({
        bucket: BUCKET,
        s3Client: s3,
        prefix: "meta-concurrent/",
      });
      await store.initialize();

      const writerA = store.appendCommit({
        commit: {
          snapshotId: "race-A" as any,
          parentId: null,
          trigger: "t",
          message: "A",
          author: { name: "a", email: "a@a" },
          timestamp: 1000,
        },
        priorHead: null,
      });
      const writerB = store.appendCommit({
        commit: {
          snapshotId: "race-B" as any,
          parentId: null,
          trigger: "t",
          message: "B",
          author: { name: "b", email: "b@b" },
          timestamp: 1001,
        },
        priorHead: null,
      });

      const results = await Promise.allSettled([writerA, writerB]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const bad = results.filter((r) => r.status === "rejected");
      expect(ok.length).toBe(1);
      expect(bad.length).toBe(1);
      expect((bad[0] as PromiseRejectedResult).reason).toBeInstanceOf(CasConflictError);
    });

    it("listCommitIds paginates correctly with many objects", async () => {
      const store = new S3MetadataStore({
        bucket: BUCKET,
        s3Client: s3,
        prefix: "meta-paginate/",
      });
      await store.initialize();

      // Insert 25 commits in a chain — exercises pagination if S3 limits
      // are smaller; even with the default 1000, this verifies the loop
      let prior: string | null = null;
      for (let i = 0; i < 25; i++) {
        const id = `paged-${i.toString().padStart(2, "0")}`;
        await store.appendCommit({
          commit: {
            snapshotId: id as any,
            parentId: prior as any,
            trigger: "t",
            message: `c${i}`,
            author: { name: "a", email: "a@a" },
            timestamp: i,
          },
          priorHead: prior as any,
        });
        prior = id;
      }

      const ids: string[] = [];
      for await (const id of store.listCommitIds()) ids.push(id);
      expect(ids.length).toBe(25);
    });
  });

  describe("end-to-end: S3-only BlobBackend", () => {
    it("commits and rollbacks survive a full S3 round-trip", async () => {
      const blobs = new S3BlobStore({ bucket: BUCKET, prefix: "e2e/blobs/", s3Client: s3 });
      const metadata = new S3MetadataStore({ bucket: BUCKET, prefix: "e2e/meta/", s3Client: s3 });
      await metadata.initialize();

      const backend = new BlobBackend({ blobs, metadata });
      const fs = new PersistentFs(new InMemoryFs(), { backend });
      await fs.boot();

      await fs.writeFile("/notes.md", "# version 1");
      const c1 = await fs.commit({ trigger: "turn_end" });

      await fs.writeFile("/notes.md", "# version 2");
      const c2 = await fs.commit({ trigger: "turn_end" });

      expect(await backend.readHead()).toBe(c2.snapshotId);

      // Restore to c1 — content should change
      await fs.rollback(c1.snapshotId);
      const content = await fs.readFile("/notes.md");
      expect(content).toBe("# version 1");

      // The blob for c2 still exists (rollback doesn't delete blobs)
      const c2BlobKey = c2.contentId ?? c2.snapshotId;
      expect(await blobs.exists(c2BlobKey)).toBe(true);

      // doctor.findOrphanBlobs finds c2's blob now that it's unreachable
      const orphans = await findOrphanBlobs({ metadataStores: [metadata], blobs });
      expect(orphans.orphanKeys).toContain(c2BlobKey);

      await pruneOrphanBlobs(blobs, orphans.orphanKeys, { apply: true });
      expect(await blobs.exists(c2BlobKey)).toBe(false);

      // verifyIntegrity walks the chain via real S3 getCommit calls
      const report = await verifyIntegrity(backend, { blobs });
      expect(report.missingCommits).toEqual([]);
      expect(report.missingBlobs).toEqual([]);
    });
  });
});
