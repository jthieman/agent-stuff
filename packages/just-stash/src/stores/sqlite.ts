import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { SnapshotId, ContentId, CommitInfo } from "../types.ts";
import { CasConflictError } from "../types.ts";
import type { BlobStore, MetadataStore } from "./types.ts";

/**
 * SqliteStore — bundles a BlobStore and MetadataStore in one SQLite file.
 *
 *   const store = new SqliteStore('./just-stash.db');
 *   await store.initialize();
 *   const backend = new BlobBackend({ blobs: store, metadata: store });
 *
 * Or use the individual halves:
 *   const store = new SqliteStore('./just-stash.db');
 *   await store.initialize();
 *   // store implements both BlobStore and MetadataStore
 *
 * WAL mode for concurrent reads. Single-writer (SQLite limitation).
 */
export class SqliteStore implements BlobStore, MetadataStore {
  private db: Database.Database | null = null;

  constructor(private readonly path: string) {}

  async initialize(): Promise<void> {
    this.db = new Database(this.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blobs (
        key  TEXT PRIMARY KEY,
        data BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS head (
        id      INTEGER PRIMARY KEY CHECK (id = 1),
        snapshot_id TEXT
      );
      INSERT OR IGNORE INTO head (id, snapshot_id) VALUES (1, NULL);

      CREATE TABLE IF NOT EXISTS commits (
        snapshot_id TEXT PRIMARY KEY,
        content_id  TEXT,
        parent_id   TEXT,
        trigger     TEXT NOT NULL,
        message     TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_email TEXT NOT NULL,
        timestamp   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notes (
        snapshot_id TEXT PRIMARY KEY,
        note        TEXT NOT NULL
      );
    `);

    const columns = new Set(
      (
        this.db.prepare("PRAGMA table_info(commits)").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    if (!columns.has("content_id")) {
      this.db.exec("ALTER TABLE commits ADD COLUMN content_id TEXT");
    }
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private requireDb(): Database.Database {
    if (!this.db) throw new Error("Store not initialized — call initialize() first");
    return this.db;
  }

  // -------------------------------------------------------------------------
  // BlobStore
  // -------------------------------------------------------------------------

  async put(content: Buffer): Promise<string> {
    const key = createHash("sha256").update(content).digest("hex");
    this.requireDb()
      .prepare("INSERT OR IGNORE INTO blobs (key, data) VALUES (?, ?)")
      .run(key, content);
    return key;
  }

  async get(key: string): Promise<Buffer> {
    const row = this.requireDb().prepare("SELECT data FROM blobs WHERE key = ?").get(key) as
      | { data: Buffer }
      | undefined;
    if (!row) throw new Error(`Blob not found: ${key}`);
    return row.data;
  }

  async exists(key: string): Promise<boolean> {
    return this.requireDb().prepare("SELECT 1 FROM blobs WHERE key = ?").get(key) !== undefined;
  }

  async delete(key: string): Promise<void> {
    this.requireDb().prepare("DELETE FROM blobs WHERE key = ?").run(key);
  }

  async *list(): AsyncIterable<string> {
    const iter = this.requireDb().prepare("SELECT key FROM blobs").iterate() as Iterable<{
      key: string;
    }>;
    for (const row of iter) yield row.key;
  }

  // -------------------------------------------------------------------------
  // MetadataStore
  // -------------------------------------------------------------------------

  async readHead(): Promise<SnapshotId | null> {
    const row = this.requireDb().prepare("SELECT snapshot_id FROM head WHERE id = 1").get() as
      | { snapshot_id: string | null }
      | undefined;
    return (row?.snapshot_id as SnapshotId | null) ?? null;
  }

  async appendCommit(opts: { commit: CommitInfo; priorHead: SnapshotId | null }): Promise<void> {
    const db = this.requireDb();
    const c = opts.commit;
    const tx = db.transaction(() => {
      // CAS check
      const row = db.prepare("SELECT snapshot_id FROM head WHERE id = 1").get() as {
        snapshot_id: string | null;
      };
      if (row.snapshot_id !== opts.priorHead) {
        throw new CasConflictError(opts.priorHead, (row.snapshot_id as SnapshotId | null) ?? null);
      }
      // Insert commit (idempotent — same snapshot_id is a no-op)
      db.prepare(
        `INSERT OR IGNORE INTO commits
          (snapshot_id, content_id, parent_id, trigger, message, author_name, author_email, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        c.snapshotId,
        c.contentId ?? null,
        c.parentId,
        c.trigger,
        c.message,
        c.author.name,
        c.author.email,
        c.timestamp,
      );
      // Advance HEAD
      db.prepare("UPDATE head SET snapshot_id = ? WHERE id = 1").run(c.snapshotId);
    });
    tx();
  }

  async setHead(target: SnapshotId, priorHead: SnapshotId): Promise<void> {
    const db = this.requireDb();
    const tx = db.transaction(() => {
      const row = db.prepare("SELECT snapshot_id FROM head WHERE id = 1").get() as {
        snapshot_id: string | null;
      };
      if (row.snapshot_id !== priorHead) {
        throw new CasConflictError(priorHead, (row.snapshot_id as SnapshotId | null) ?? null);
      }
      const exists = db.prepare("SELECT 1 FROM commits WHERE snapshot_id = ?").get(target);
      if (!exists) throw new Error(`Cannot set HEAD: unknown commit ${target}`);
      db.prepare("UPDATE head SET snapshot_id = ? WHERE id = 1").run(target);
    });
    tx();
  }

  async getCommit(snapshotId: SnapshotId): Promise<CommitInfo | null> {
    const row = this.requireDb()
      .prepare("SELECT * FROM commits WHERE snapshot_id = ?")
      .get(snapshotId) as CommitRow | undefined;
    return row ? rowToCommit(row) : null;
  }

  async log(opts?: { limit?: number; since?: SnapshotId }): Promise<CommitInfo[]> {
    const limit = opts?.limit ?? Infinity;
    const result: CommitInfo[] = [];
    const db = this.requireDb();
    const headRow = db.prepare("SELECT snapshot_id FROM head WHERE id = 1").get() as {
      snapshot_id: string | null;
    };
    let cursor: string | null = headRow.snapshot_id;
    const seen = new Set<string>();
    const getStmt = db.prepare("SELECT * FROM commits WHERE snapshot_id = ?");
    while (cursor && result.length < limit) {
      if (opts?.since && cursor === opts.since) break;
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const row = getStmt.get(cursor) as CommitRow | undefined;
      if (!row) break;
      result.push(rowToCommit(row));
      cursor = row.parent_id;
    }
    return result;
  }

  async putNote(snapshotId: SnapshotId, note: string): Promise<void> {
    this.requireDb()
      .prepare(
        `INSERT INTO notes (snapshot_id, note) VALUES (?, ?)
         ON CONFLICT(snapshot_id) DO UPDATE SET note = excluded.note`,
      )
      .run(snapshotId, note);
  }

  async getNote(snapshotId: SnapshotId): Promise<string | null> {
    const row = this.requireDb()
      .prepare("SELECT note FROM notes WHERE snapshot_id = ?")
      .get(snapshotId) as { note: string } | undefined;
    return row?.note ?? null;
  }

  async *listCommitIds(): AsyncIterable<SnapshotId> {
    const iter = this.requireDb().prepare("SELECT snapshot_id FROM commits").iterate() as Iterable<{
      snapshot_id: string;
    }>;
    for (const row of iter) yield row.snapshot_id as SnapshotId;
  }

  async deleteCommit(snapshotId: SnapshotId): Promise<void> {
    const db = this.requireDb();
    db.prepare("DELETE FROM commits WHERE snapshot_id = ?").run(snapshotId);
    db.prepare("DELETE FROM notes WHERE snapshot_id = ?").run(snapshotId);
  }
}

interface CommitRow {
  snapshot_id: string;
  content_id: string | null;
  parent_id: string | null;
  trigger: string;
  message: string;
  author_name: string;
  author_email: string;
  timestamp: number;
}

function rowToCommit(row: CommitRow): CommitInfo {
  return {
    snapshotId: row.snapshot_id as SnapshotId,
    contentId: (row.content_id as ContentId | null) ?? undefined,
    parentId: (row.parent_id as SnapshotId | null) ?? null,
    trigger: row.trigger,
    message: row.message,
    author: { name: row.author_name, email: row.author_email },
    timestamp: row.timestamp,
  };
}
