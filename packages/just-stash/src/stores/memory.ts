import { createHash } from "node:crypto";
import type { SnapshotId, CommitInfo } from "../types.ts";
import { CasConflictError } from "../types.ts";
import type { BlobStore, MetadataStore } from "./types.ts";
import { BlobBackend } from "../backends/blob.ts";

// ---------------------------------------------------------------------------
// InMemoryBlobStore
// ---------------------------------------------------------------------------

export class InMemoryBlobStore implements BlobStore {
  private blobs: Map<string, Buffer>;

  constructor(shared?: Map<string, Buffer>) {
    this.blobs = shared ?? new Map();
  }

  /** Share underlying state — for testing concurrent access. */
  cloneHandle(): InMemoryBlobStore {
    return new InMemoryBlobStore(this.blobs);
  }

  async put(content: Buffer): Promise<string> {
    const key = createHash("sha256").update(content).digest("hex");
    if (!this.blobs.has(key)) this.blobs.set(key, content);
    return key;
  }

  async get(key: string): Promise<Buffer> {
    const buf = this.blobs.get(key);
    if (!buf) throw new Error(`Blob not found: ${key}`);
    return buf;
  }

  async exists(key: string): Promise<boolean> {
    return this.blobs.has(key);
  }
  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }
  async *list(): AsyncIterable<string> {
    for (const k of this.blobs.keys()) yield k;
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// InMemoryMetadataStore
// ---------------------------------------------------------------------------

interface MetadataState {
  head: SnapshotId | null;
  commits: Map<SnapshotId, CommitInfo>;
  notes: Map<SnapshotId, string>;
}

export class InMemoryMetadataStore implements MetadataStore {
  private state: MetadataState;

  constructor(shared?: MetadataState) {
    this.state = shared ?? { head: null, commits: new Map(), notes: new Map() };
  }

  /** Share underlying state — for testing concurrent access. */
  cloneHandle(): InMemoryMetadataStore {
    return new InMemoryMetadataStore(this.state);
  }

  async readHead(): Promise<SnapshotId | null> {
    return this.state.head;
  }

  async appendCommit(opts: { commit: CommitInfo; priorHead: SnapshotId | null }): Promise<void> {
    if (this.state.head !== opts.priorHead) {
      throw new CasConflictError(opts.priorHead, this.state.head);
    }
    this.state.commits.set(opts.commit.snapshotId, opts.commit);
    this.state.head = opts.commit.snapshotId;
  }

  async setHead(target: SnapshotId, priorHead: SnapshotId): Promise<void> {
    if (this.state.head !== priorHead) {
      throw new CasConflictError(priorHead, this.state.head);
    }
    if (!this.state.commits.has(target)) {
      throw new Error(`Cannot set HEAD: unknown commit ${target}`);
    }
    this.state.head = target;
  }

  async getCommit(snapshotId: SnapshotId): Promise<CommitInfo | null> {
    return this.state.commits.get(snapshotId) ?? null;
  }

  async log(opts?: { limit?: number; since?: SnapshotId }): Promise<CommitInfo[]> {
    const limit = opts?.limit ?? Infinity;
    const result: CommitInfo[] = [];
    const seen = new Set<SnapshotId>();
    let cursor: SnapshotId | null = this.state.head;
    while (cursor && result.length < limit) {
      if (opts?.since && cursor === opts.since) break;
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const c = this.state.commits.get(cursor);
      if (!c) break;
      result.push(c);
      cursor = c.parentId;
    }
    return result;
  }

  async putNote(snapshotId: SnapshotId, note: string): Promise<void> {
    this.state.notes.set(snapshotId, note);
  }

  async getNote(snapshotId: SnapshotId): Promise<string | null> {
    return this.state.notes.get(snapshotId) ?? null;
  }

  async *listCommitIds(): AsyncIterable<SnapshotId> {
    for (const id of this.state.commits.keys()) yield id;
  }

  async deleteCommit(snapshotId: SnapshotId): Promise<void> {
    this.state.commits.delete(snapshotId);
    this.state.notes.delete(snapshotId);
  }

  async close(): Promise<void> {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// MemoryBackend — convenience factory
// ---------------------------------------------------------------------------

/**
 * In-memory SnapshotBackend. For tests and ephemeral demos.
 *
 *   const backend = new MemoryBackend();
 *
 * Use `backend.cloneHandle()` to get a second instance sharing state —
 * useful for testing concurrent commits.
 */
export class MemoryBackend extends BlobBackend {
  private readonly _blobs: InMemoryBlobStore;
  private readonly _metadata: InMemoryMetadataStore;

  constructor(opts?: { blobs?: InMemoryBlobStore; metadata?: InMemoryMetadataStore }) {
    const blobs = opts?.blobs ?? new InMemoryBlobStore();
    const metadata = opts?.metadata ?? new InMemoryMetadataStore();
    super({ blobs, metadata });
    this._blobs = blobs;
    this._metadata = metadata;
  }

  /**
   * Return a second MemoryBackend sharing the same underlying state.
   * Both backends see each other's writes. Useful for testing concurrent
   * access (CAS, dedup) without spawning processes.
   */
  cloneHandle(): MemoryBackend {
    return new MemoryBackend({
      blobs: this._blobs.cloneHandle(),
      metadata: this._metadata.cloneHandle(),
    });
  }
}
