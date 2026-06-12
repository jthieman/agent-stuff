import type { Pool } from "pg";
import type { SnapshotId, ContentId, CommitInfo } from "../types.ts";
import { CasConflictError } from "../types.ts";
import type { MetadataStore } from "./types.ts";

export interface PostgresMetadataStoreOptions {
  pool: Pool;
  /** Table-name prefix. Default 'just_stash_'. */
  tablePrefix?: string;
  /** Run CREATE TABLE IF NOT EXISTS on initialize. Default true. */
  autoMigrate?: boolean;
}

/**
 * Postgres MetadataStore. Pairs with any BlobStore (typically S3 or R2).
 *
 *   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *   const meta = new PostgresMetadataStore({ pool });
 *   await meta.initialize();
 *
 *   const backend = new BlobBackend({
 *     blobs: new S3BlobStore({ bucket }),
 *     metadata: meta,
 *   });
 *
 * Three tables (with configurable prefix):
 *   - {prefix}head    one row: the current HEAD pointer
 *   - {prefix}commits one row per commit, parent_id forms the chain
 *   - {prefix}notes   one row per noted snapshot
 *
 * CAS uses Postgres transactions with row locking on the head table.
 * Pool lifecycle is caller-managed — close() does NOT close the pool.
 */
export class PostgresMetadataStore implements MetadataStore {
  private readonly pool: Pool;
  private readonly prefix: string;
  private readonly autoMigrate: boolean;

  constructor(opts: PostgresMetadataStoreOptions) {
    this.pool = opts.pool;
    this.prefix = opts.tablePrefix ?? "just_stash_";
    validateTablePrefix(this.prefix);
    this.autoMigrate = opts.autoMigrate ?? true;
  }

  private get headTable() {
    return `"${this.prefix}head"`;
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
    // Ensure the singleton head row exists
    await this.pool.query(
      `INSERT INTO ${this.headTable} (id, snapshot_id) VALUES (1, NULL)
       ON CONFLICT (id) DO NOTHING`,
    );
  }

  async close(): Promise<void> {
    /* pool managed by caller */
  }

  schemaSql(): string {
    return `
      CREATE TABLE IF NOT EXISTS ${this.headTable} (
        id          SMALLINT PRIMARY KEY CHECK (id = 1),
        snapshot_id TEXT
      );

      CREATE TABLE IF NOT EXISTS ${this.commitsTable} (
        snapshot_id  TEXT PRIMARY KEY,
        content_id   TEXT,
        parent_id    TEXT,
        trigger      TEXT NOT NULL,
        message      TEXT NOT NULL,
        author_name  TEXT NOT NULL,
        author_email TEXT NOT NULL,
        timestamp    BIGINT NOT NULL
      );

      ALTER TABLE ${this.commitsTable}
        ADD COLUMN IF NOT EXISTS content_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_${this.prefix}commits_parent
        ON ${this.commitsTable}(parent_id);

      CREATE TABLE IF NOT EXISTS ${this.notesTable} (
        snapshot_id TEXT PRIMARY KEY,
        note        TEXT NOT NULL
      );
    `;
  }

  async readHead(): Promise<SnapshotId | null> {
    const res = await this.pool.query(`SELECT snapshot_id FROM ${this.headTable} WHERE id = 1`);
    if (res.rowCount === 0) return null;
    return (res.rows[0].snapshot_id as SnapshotId | null) ?? null;
  }

  async appendCommit(opts: { commit: CommitInfo; priorHead: SnapshotId | null }): Promise<void> {
    const c = opts.commit;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Lock and read HEAD
      const headRes = await client.query(
        `SELECT snapshot_id FROM ${this.headTable} WHERE id = 1 FOR UPDATE`,
      );
      const current = (headRes.rows[0]?.snapshot_id as SnapshotId | null) ?? null;
      if (current !== opts.priorHead) {
        await client.query("ROLLBACK");
        throw new CasConflictError(opts.priorHead, current);
      }
      // Insert commit (idempotent)
      await client.query(
        `INSERT INTO ${this.commitsTable}
          (snapshot_id, content_id, parent_id, trigger, message, author_name, author_email, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (snapshot_id) DO NOTHING`,
        [
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
      await client.query(`UPDATE ${this.headTable} SET snapshot_id = $1 WHERE id = 1`, [
        c.snapshotId,
      ]);
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
      const headRes = await client.query(
        `SELECT snapshot_id FROM ${this.headTable} WHERE id = 1 FOR UPDATE`,
      );
      const current = (headRes.rows[0]?.snapshot_id as SnapshotId | null) ?? null;
      if (current !== priorHead) {
        await client.query("ROLLBACK");
        throw new CasConflictError(priorHead, current);
      }
      const exists = await client.query(
        `SELECT 1 FROM ${this.commitsTable} WHERE snapshot_id = $1`,
        [target],
      );
      if (exists.rowCount === 0) {
        await client.query("ROLLBACK");
        throw new Error(`Cannot set HEAD: unknown commit ${target}`);
      }
      await client.query(`UPDATE ${this.headTable} SET snapshot_id = $1 WHERE id = 1`, [target]);
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
    const res = await this.pool.query(`SELECT * FROM ${this.commitsTable} WHERE snapshot_id = $1`, [
      snapshotId,
    ]);
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
      `INSERT INTO ${this.notesTable} (snapshot_id, note) VALUES ($1, $2)
       ON CONFLICT (snapshot_id) DO UPDATE SET note = EXCLUDED.note`,
      [snapshotId, note],
    );
  }

  async getNote(snapshotId: SnapshotId): Promise<string | null> {
    const res = await this.pool.query(
      `SELECT note FROM ${this.notesTable} WHERE snapshot_id = $1`,
      [snapshotId],
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
        `DECLARE just_stash_cursor CURSOR FOR SELECT snapshot_id FROM ${this.commitsTable}`,
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
      await client.query(`DELETE FROM ${this.commitsTable} WHERE snapshot_id = $1`, [snapshotId]);
      await client.query(`DELETE FROM ${this.notesTable} WHERE snapshot_id = $1`, [snapshotId]);
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
}
