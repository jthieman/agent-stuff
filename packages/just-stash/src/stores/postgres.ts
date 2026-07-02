import type { Pool, PoolClient, QueryResult } from "pg";
import type { SnapshotId, ContentId, CommitInfo } from "../types.ts";
import { CasConflictError } from "../types.ts";
import type { MetadataStore } from "./types.ts";

export interface PostgresMetadataStoreOptions {
  pool: Pool;
  /** Logical timeline namespace. Default 'default'. */
  namespace?: string;
  /** Table-name prefix. Default 'just_stash_'. */
  tablePrefix?: string;
  /** Run CREATE TABLE IF NOT EXISTS on initialize. Default true. */
  autoMigrate?: boolean;
}

/**
 * Postgres MetadataStore. Pairs with any BlobStore (typically S3 or R2).
 *
 *   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *   const meta = new PostgresMetadataStore({ pool, namespace: sandboxId });
 *   await meta.initialize();
 *
 *   const backend = new BlobBackend({
 *     blobs: new S3BlobStore({ bucket }),
 *     metadata: meta,
 *   });
 *
 * Three shared tables (with configurable prefix):
 *   - {prefix}heads   one row per namespace: the current HEAD pointer
 *   - {prefix}commits one row per namespace/commit, parent_id forms the chain
 *   - {prefix}notes   one row per namespace/noted snapshot
 *
 * CAS uses Postgres transactions with row locking on the namespace's head row.
 * Pool lifecycle is caller-managed — close() does NOT close the pool.
 */
export class PostgresMetadataStore implements MetadataStore {
  private readonly pool: Pool;
  private readonly namespace: string;
  private readonly prefix: string;
  private readonly autoMigrate: boolean;

  constructor(opts: PostgresMetadataStoreOptions) {
    this.pool = opts.pool;
    this.namespace = opts.namespace ?? "default";
    validateNamespace(this.namespace);
    this.prefix = opts.tablePrefix ?? "just_stash_";
    validateTablePrefix(this.prefix);
    this.autoMigrate = opts.autoMigrate ?? true;
  }

  private get headsTable() {
    return `"${this.prefix}heads"`;
  }
  private get commitsTable() {
    return `"${this.prefix}commits"`;
  }
  private get notesTable() {
    return `"${this.prefix}notes"`;
  }

  async initialize(): Promise<void> {
    if (this.autoMigrate) {
      await this.pool.query(this.schemaSql());
    }
    await this.ensureHeadRow(this.pool);
  }

  async close(): Promise<void> {
    /* pool managed by caller */
  }

  schemaSql(): string {
    return `
      CREATE TABLE IF NOT EXISTS ${this.headsTable} (
        namespace   TEXT PRIMARY KEY,
        snapshot_id TEXT
      );

      CREATE TABLE IF NOT EXISTS ${this.commitsTable} (
        namespace    TEXT NOT NULL,
        snapshot_id  TEXT NOT NULL,
        content_id   TEXT,
        parent_id    TEXT,
        trigger      TEXT NOT NULL,
        message      TEXT NOT NULL,
        author_name  TEXT NOT NULL,
        author_email TEXT NOT NULL,
        timestamp    BIGINT NOT NULL,
        PRIMARY KEY (namespace, snapshot_id)
      );

      CREATE TABLE IF NOT EXISTS ${this.notesTable} (
        namespace   TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        note        TEXT NOT NULL,
        PRIMARY KEY (namespace, snapshot_id)
      );

    `;
  }

  private async ensureHeadRow(queryable: Queryable): Promise<void> {
    await queryable.query(
      `INSERT INTO ${this.headsTable} (namespace, snapshot_id) VALUES ($1, NULL)
       ON CONFLICT (namespace) DO NOTHING`,
      [this.namespace],
    );
  }

  private async lockHead(client: PoolClient): Promise<SnapshotId | null> {
    await this.ensureHeadRow(client);
    const headRes = await client.query(
      `SELECT snapshot_id FROM ${this.headsTable} WHERE namespace = $1 FOR UPDATE`,
      [this.namespace],
    );
    return (headRes.rows[0]?.snapshot_id as SnapshotId | null) ?? null;
  }

  async readHead(): Promise<SnapshotId | null> {
    const res = await this.pool.query(
      `SELECT snapshot_id FROM ${this.headsTable} WHERE namespace = $1`,
      [this.namespace],
    );
    if (res.rowCount === 0) return null;
    return (res.rows[0].snapshot_id as SnapshotId | null) ?? null;
  }

  async appendCommit(opts: { commit: CommitInfo; priorHead: SnapshotId | null }): Promise<void> {
    const c = opts.commit;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await this.lockHead(client);
      if (current !== opts.priorHead) {
        await client.query("ROLLBACK");
        throw new CasConflictError(opts.priorHead, current);
      }
      // Insert commit (idempotent)
      await client.query(
        `INSERT INTO ${this.commitsTable}
          (namespace, snapshot_id, content_id, parent_id, trigger, message, author_name, author_email, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (namespace, snapshot_id) DO NOTHING`,
        [
          this.namespace,
          c.snapshotId,
          c.contentId ?? null,
          c.parentId,
          c.trigger,
          c.message,
          c.author.name,
          c.author.email,
          c.timestamp,
        ],
      );
      // Advance HEAD
      await client.query(
        `UPDATE ${this.headsTable}
            SET snapshot_id = $2
          WHERE namespace = $1`,
        [this.namespace, c.snapshotId],
      );
      await client.query("COMMIT");
    } catch (e) {
      // ROLLBACK is no-op if already rolled back
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw e;
    } finally {
      client.release();
    }
  }

  async setHead(target: SnapshotId, priorHead: SnapshotId): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await this.lockHead(client);
      if (current !== priorHead) {
        await client.query("ROLLBACK");
        throw new CasConflictError(priorHead, current);
      }
      const exists = await client.query(
        `SELECT 1 FROM ${this.commitsTable} WHERE namespace = $1 AND snapshot_id = $2`,
        [this.namespace, target],
      );
      if (exists.rowCount === 0) {
        await client.query("ROLLBACK");
        throw new Error(`Cannot set HEAD: unknown commit ${target}`);
      }
      await client.query(
        `UPDATE ${this.headsTable}
            SET snapshot_id = $2
          WHERE namespace = $1`,
        [this.namespace, target],
      );
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw e;
    } finally {
      client.release();
    }
  }

  async getCommit(snapshotId: SnapshotId): Promise<CommitInfo | null> {
    const res = await this.pool.query(
      `SELECT * FROM ${this.commitsTable} WHERE namespace = $1 AND snapshot_id = $2`,
      [this.namespace, snapshotId],
    );
    return res.rowCount === 0 ? null : rowToCommit(res.rows[0]);
  }

  async log(opts?: { limit?: number; since?: SnapshotId }): Promise<CommitInfo[]> {
    const head = await this.readHead();
    if (!head) return [];
    const limit = opts?.limit ?? Infinity;
    const result: CommitInfo[] = [];
    let cursor: SnapshotId | null = head;
    const seen = new Set<SnapshotId>();
    while (cursor && result.length < limit) {
      if (opts?.since && cursor === opts.since) break;
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const row = await this.getCommit(cursor);
      if (!row) break;
      result.push(row);
      cursor = row.parentId;
    }
    return result;
  }

  async putNote(snapshotId: SnapshotId, note: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.notesTable} (namespace, snapshot_id, note) VALUES ($1, $2, $3)
       ON CONFLICT (namespace, snapshot_id) DO UPDATE SET note = EXCLUDED.note`,
      [this.namespace, snapshotId, note],
    );
  }

  async getNote(snapshotId: SnapshotId): Promise<string | null> {
    const res = await this.pool.query(
      `SELECT note FROM ${this.notesTable} WHERE namespace = $1 AND snapshot_id = $2`,
      [this.namespace, snapshotId],
    );
    return res.rowCount === 0 ? null : (res.rows[0].note as string);
  }

  async *listCommitIds(): AsyncIterable<SnapshotId> {
    // Use a cursor for memory-safe streaming on large histories
    const client = await this.pool.connect();
    let committed = false;
    let releaseError: Error | true | undefined;
    try {
      await client.query("BEGIN");
      await client.query(
        `DECLARE just_stash_cursor CURSOR FOR
           SELECT snapshot_id
             FROM ${this.commitsTable}
            WHERE namespace = $1`,
        [this.namespace],
      );
      while (true) {
        const res = await client.query("FETCH 1000 FROM just_stash_cursor");
        if (res.rowCount === 0) break;
        for (const row of res.rows) yield row.snapshot_id as SnapshotId;
      }
      await client.query("COMMIT");
      committed = true;
    } catch (e) {
      releaseError = e instanceof Error ? e : true;
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw e;
    } finally {
      if (!committed && releaseError === undefined) {
        try {
          await client.query("ROLLBACK");
        } catch (e) {
          releaseError = e instanceof Error ? e : true;
        }
        releaseError ??= true;
      }

      client.release(releaseError);
    }
  }

  async deleteCommit(snapshotId: SnapshotId): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM ${this.commitsTable} WHERE namespace = $1 AND snapshot_id = $2`,
        [this.namespace, snapshotId],
      );
      await client.query(
        `DELETE FROM ${this.notesTable} WHERE namespace = $1 AND snapshot_id = $2`,
        [this.namespace, snapshotId],
      );
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw e;
    } finally {
      client.release();
    }
  }
}

function rowToCommit(row: any): CommitInfo {
  return {
    snapshotId: row.snapshot_id as SnapshotId,
    contentId: (row.content_id as ContentId | null) ?? undefined,
    parentId: (row.parent_id as SnapshotId | null) ?? null,
    trigger: row.trigger,
    message: row.message,
    author: { name: row.author_name, email: row.author_email },
    timestamp: Number(row.timestamp),
  };
}

function validateTablePrefix(prefix: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
    throw new Error(
      `Invalid Postgres tablePrefix '${prefix}'. Must be a safe SQL identifier prefix.`,
    );
  }
  for (const identifier of generatedIdentifiers(prefix)) {
    if (identifier.length > 63) {
      throw new Error(
        `Invalid Postgres tablePrefix '${prefix}'. Generated identifier names must be 63 characters or fewer.`,
      );
    }
  }
}

function validateNamespace(namespace: string): void {
  if (namespace.length === 0 || namespace.includes("\0")) {
    throw new Error("Invalid Postgres namespace. Must be a non-empty string without null bytes.");
  }
}

function generatedIdentifiers(prefix: string): string[] {
  return [`${prefix}heads`, `${prefix}commits`, `${prefix}notes`];
}

interface Queryable {
  query(queryText: string, values?: unknown[]): Promise<QueryResult>;
}
