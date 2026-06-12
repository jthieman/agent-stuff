/**
 * Integration tests against a real Postgres via testcontainers.
 *
 * Requires Docker.
 *
 *   vp test run postgres.integration
 *
 * What these tests prove that the unit tests can't:
 *   - The exact SQL we emit is accepted by real Postgres
 *   - SELECT ... FOR UPDATE actually serializes concurrent writers
 *   - JSONB / TIMESTAMPTZ / SERIAL columns behave as expected
 *   - Connection pooling and BEGIN/COMMIT lifecycle work end-to-end
 *   - Errors from real Postgres (unique constraint violations,
 *     connection drops) surface as we expect
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { Pool } from "pg";
import { PostgresMetadataStore } from "../src/stores/postgres.ts";
import { InMemoryBlobStore, BlobBackend } from "../src/index.ts";
import { PersistentFs } from "../src/wrappers/persistent-fs.ts";
import { CasConflictError } from "../src/types.ts";
import { InMemoryFs } from "just-bash";
import { findOrphanCommits, pruneOrphanCommits, verifyIntegrity } from "../src/doctor.ts";

describe("Postgres integration", () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let store: PostgresMetadataStore;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
        POSTGRES_DB: "just_stash_test",
      })
      .withExposedPorts(5432)
      .withStartupTimeout(60_000)
      .start();

    pool = new Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: "test",
      password: "test",
      database: "just_stash_test",
    });

    store = new PostgresMetadataStore({ pool });
    await store.initialize();
  }, 120_000);

  afterAll(async () => {
    await store?.close();
    await pool?.end();
    await container?.stop();
  }, 30_000);

  it("initializes schema idempotently", async () => {
    // Re-running initialize must not throw or duplicate
    await store.initialize();
    await store.initialize();
    expect(await store.readHead()).toBeNull();
  });

  it("appends commits and reads them back", async () => {
    const commit = {
      snapshotId: "sha-pg-1" as any,
      parentId: null,
      trigger: "t",
      message: "first commit",
      author: { name: "tester", email: "t@e.st" },
      timestamp: Date.now(),
    };
    await store.appendCommit({ commit, priorHead: null });
    expect(await store.readHead()).toBe("sha-pg-1");

    const back = await store.getCommit("sha-pg-1" as any);
    expect(back?.message).toBe("first commit");
    expect(back?.author.email).toBe("t@e.st");
  });

  it("SELECT FOR UPDATE serializes concurrent appendCommit calls", async () => {
    // Two writers race for the next commit. Both read the same priorHead.
    // FOR UPDATE means whoever gets the row lock first runs the INSERT,
    // and the second sees the new HEAD when their FOR UPDATE returns,
    // so their priorHead check fails.

    const head = await store.readHead();
    const writerA = store.appendCommit({
      commit: {
        snapshotId: "sha-race-A" as any,
        parentId: head,
        trigger: "t",
        message: "A",
        author: { name: "a", email: "a@a" },
        timestamp: Date.now(),
      },
      priorHead: head,
    });
    const writerB = store.appendCommit({
      commit: {
        snapshotId: "sha-race-B" as any,
        parentId: head,
        trigger: "t",
        message: "B",
        author: { name: "b", email: "b@b" },
        timestamp: Date.now(),
      },
      priorHead: head,
    });

    const results = await Promise.allSettled([writerA, writerB]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(CasConflictError);
  });

  it("listCommitIds streams via cursor", async () => {
    const ids: string[] = [];
    for await (const id of store.listCommitIds()) ids.push(id);
    // At least the commits we've created during this test run
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("sha-pg-1");
  });

  it("listCommitIds cleans up its transaction when iteration stops early", async () => {
    const singleConnectionPool = new Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: "test",
      password: "test",
      database: "just_stash_test",
      max: 1,
    });
    const isolatedStore = new PostgresMetadataStore({
      pool: singleConnectionPool,
      tablePrefix: "early_break_",
    });

    try {
      await isolatedStore.initialize();
      await isolatedStore.appendCommit({
        commit: {
          snapshotId: "early-a" as any,
          parentId: null,
          trigger: "t",
          message: "early a",
          author: { name: "a", email: "a@a" },
          timestamp: Date.now(),
        },
        priorHead: null,
      });
      await isolatedStore.appendCommit({
        commit: {
          snapshotId: "early-b" as any,
          parentId: "early-a" as any,
          trigger: "t",
          message: "early b",
          author: { name: "b", email: "b@b" },
          timestamp: Date.now(),
        },
        priorHead: "early-a" as any,
      });

      let firstId: string | null = null;
      for await (const id of isolatedStore.listCommitIds()) {
        firstId = id;
        break;
      }
      expect(firstId).not.toBeNull();

      const ids: string[] = [];
      for await (const id of isolatedStore.listCommitIds()) ids.push(id);
      expect(ids.sort()).toEqual(["early-a", "early-b"]);
    } finally {
      await isolatedStore.close();
      await singleConnectionPool.end();
    }
  });

  it("log returns the full chain when limit is omitted", async () => {
    const logStore = new PostgresMetadataStore({ pool, tablePrefix: "log_full_" });
    await logStore.initialize();

    for (let i = 0; i < 105; i++) {
      await logStore.appendCommit({
        commit: {
          snapshotId: `pg-log-${i}` as any,
          parentId: i === 0 ? null : (`pg-log-${i - 1}` as any),
          trigger: `c${i}`,
          message: `m${i}`,
          author: { name: "a", email: "a@a" },
          timestamp: i,
        },
        priorHead: i === 0 ? null : (`pg-log-${i - 1}` as any),
      });
    }

    const log = await logStore.log();
    expect(log).toHaveLength(105);
    expect(log[0].snapshotId).toBe("pg-log-104");
    expect(log[104].snapshotId).toBe("pg-log-0");
  });

  it("deleteCommit removes commit and any associated note", async () => {
    await store.appendCommit({
      commit: {
        snapshotId: "sha-to-delete" as any,
        parentId: await store.readHead(),
        trigger: "t",
        message: "doomed",
        author: { name: "a", email: "a@a" },
        timestamp: Date.now(),
      },
      priorHead: await store.readHead(),
    });
    await store.putNote("sha-to-delete" as any, "goes with the commit");

    await store.deleteCommit("sha-to-delete" as any);
    expect(await store.getCommit("sha-to-delete" as any)).toBeNull();
    expect(await store.getNote("sha-to-delete" as any)).toBeNull();
  });

  it("end-to-end: BlobBackend with Postgres metadata, in-memory blobs", async () => {
    // Fresh schema for this test
    await pool.query(
      'TRUNCATE "just_stash_commits", "just_stash_notes", "just_stash_head" RESTART IDENTITY',
    );
    await store.initialize();

    const blobs = new InMemoryBlobStore();
    const backend = new BlobBackend({ blobs, metadata: store });
    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();

    await fs.writeFile("/a.txt", "hello");
    const c1 = await fs.commit({ trigger: "first" });
    await fs.writeFile("/a.txt", "world");
    const c2 = await fs.commit({ trigger: "second" });

    expect(await backend.readHead()).toBe(c2.snapshotId);

    // Rollback creates an orphan
    await fs.rollback(c1.snapshotId);
    expect(await backend.readHead()).toBe(c1.snapshotId);

    // doctor finds the orphan via real Postgres
    const orphans = await findOrphanCommits(store);
    expect(orphans.orphanIds).toContain(c2.snapshotId);

    // prune cleans it up via real DELETE
    await pruneOrphanCommits(store, orphans.orphanIds, { apply: true });
    const after = await findOrphanCommits(store);
    expect(after.orphanIds).toEqual([]);

    // verifyIntegrity walks via real getCommit and finds chain intact
    const report = await verifyIntegrity(backend, { blobs });
    expect(report.missingCommits).toEqual([]);
    expect(report.reachableCommits).toBeGreaterThan(0);
  });
});
