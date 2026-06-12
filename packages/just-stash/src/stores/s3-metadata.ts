import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { SnapshotId, ContentId, CommitInfo } from "../types.ts";
import { CasConflictError } from "../types.ts";
import type { MetadataStore } from "./types.ts";

export interface S3MetadataStoreOptions {
  bucket: string;
  region?: string;
  /** S3-compatible endpoint (MinIO, R2, Tigris). Enables forcePathStyle. */
  endpoint?: string;
  /** Key prefix. Default 'metadata/'. */
  prefix?: string;
  /** Pre-built S3 client; built from other options if omitted. */
  s3Client?: S3Client;
}

/**
 * S3-only `MetadataStore`. Pair with `S3BlobStore` for a zero-extra-
 * infrastructure deployment: just an S3 bucket, nothing else.
 *
 *   const blobs = new S3BlobStore({ bucket: 'just-stash' });
 *   const metadata = new S3MetadataStore({ bucket: 'just-stash' });
 *   await metadata.initialize();
 *   const backend = new BlobBackend({ blobs, metadata });
 *
 * Works on any S3-compatible store that supports conditional writes:
 * AWS S3 (since late 2024), Cloudflare R2, Tigris, MinIO, etc.
 *
 * Layout (under `prefix`):
 *
 *   HEAD                     — single object holding the current snapshotId
 *                              (or empty when no commits yet). Updates use
 *                              If-Match on its ETag for atomic CAS.
 *   commits/<snapshotId>     — one JSON object per commit
 *   notes/<snapshotId>       — one text object per note (optional)
 *
 * Concurrency:
 *   - appendCommit: PUT HEAD with If-Match: <etag-from-prior-read>
 *     → 412 Precondition Failed → CasConflictError, caller retries
 *   - First-ever commit: PUT HEAD with If-None-Match: "*"
 *     → 412 if HEAD already exists → CasConflictError
 *   - Commit objects are keyed by snapshotId; PUTs are idempotent
 *     because the commit id is derived from the serialized commit.
 *
 * Notes on HEAD encoding:
 *   The HEAD object's body is the snapshotId as plain text, or the
 *   single byte `-` when HEAD is null (no commits). We use a sentinel
 *   rather than deleting the object because deletion changes the
 *   ETag semantics (a deleted-then-created object gets a new etag,
 *   defeating CAS).
 */
export class S3MetadataStore implements MetadataStore {
  private readonly s3: S3Client;
  private readonly ownsClient: boolean;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(opts: S3MetadataStoreOptions) {
    this.bucket = opts.bucket;
    this.prefix = opts.prefix ?? "metadata/";
    this.ownsClient = !opts.s3Client;
    this.s3 =
      opts.s3Client ??
      new S3Client({
        region: opts.region ?? "us-east-1",
        endpoint: opts.endpoint,
        forcePathStyle: !!opts.endpoint,
      });
  }

  /**
   * Initialize HEAD if it doesn't exist. Conditional PUT with
   * If-None-Match — race-safe; if another caller initializes first,
   * we accept their HEAD.
   */
  async initialize(): Promise<void> {
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.headKey(),
          Body: NULL_HEAD,
          ContentType: "text/plain",
          IfNoneMatch: "*",
        }),
      );
    } catch (e: any) {
      if (isPreconditionFailed(e)) return; // already exists
      throw e;
    }
  }

  async close(): Promise<void> {
    if (this.ownsClient) this.s3.destroy();
  }

  private headKey(): string {
    return this.prefix + "HEAD";
  }
  private commitKey(id: SnapshotId): string {
    return `${this.prefix}commits/${id}`;
  }
  private noteKey(id: SnapshotId): string {
    return `${this.prefix}notes/${id}`;
  }

  // ---------------------------------------------------------------------
  // HEAD
  // ---------------------------------------------------------------------

  async readHead(): Promise<SnapshotId | null> {
    const { value } = await this.readHeadWithEtag();
    return value;
  }

  private async readHeadWithEtag(): Promise<{ value: SnapshotId | null; etag: string | null }> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.headKey() }),
      );
      const body = await streamToString(res.Body);
      const etag = res.ETag ?? null;
      const value = body === NULL_HEAD || body === "" ? null : (body as SnapshotId);
      return { value, etag };
    } catch (e: any) {
      if (isNotFound(e)) {
        // HEAD doesn't exist yet → treat as null with no etag (caller
        // must use If-None-Match: "*" for the first write)
        return { value: null, etag: null };
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------------
  // appendCommit
  // ---------------------------------------------------------------------

  async appendCommit(opts: { commit: CommitInfo; priorHead: SnapshotId | null }): Promise<void> {
    // Read HEAD + etag to do CAS atomically on the update.
    // Caller passes priorHead representing what they SAW; we verify
    // current S3 state matches that AND swap atomically.
    const { value: currentValue, etag } = await this.readHeadWithEtag();
    if (currentValue !== opts.priorHead) {
      throw new CasConflictError(opts.priorHead, currentValue);
    }

    // Write commit object first. Idempotent for the same commit id.
    // (If we wrote HEAD first and then crashed, the commit object would
    // be missing and readers would see a dangling HEAD.)
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.commitKey(opts.commit.snapshotId),
        Body: JSON.stringify(serializeCommit(opts.commit)),
        ContentType: "application/json",
      }),
    );

    // Now CAS-swap HEAD.
    try {
      if (etag === null) {
        // HEAD object didn't exist when we read it. Use If-None-Match.
        await this.s3.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.headKey(),
            Body: opts.commit.snapshotId,
            ContentType: "text/plain",
            IfNoneMatch: "*",
          }),
        );
      } else {
        // HEAD existed; use If-Match on its etag.
        await this.s3.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.headKey(),
            Body: opts.commit.snapshotId,
            ContentType: "text/plain",
            IfMatch: etag,
          }),
        );
      }
    } catch (e: any) {
      if (isPreconditionFailed(e)) {
        // Re-read to surface the actual current head for the error
        const actual = await this.readHead();
        throw new CasConflictError(opts.priorHead, actual);
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------------
  // setHead (rollback)
  // ---------------------------------------------------------------------

  async setHead(target: SnapshotId, priorHead: SnapshotId): Promise<void> {
    const { value: currentValue, etag } = await this.readHeadWithEtag();
    if (currentValue !== priorHead) {
      throw new CasConflictError(priorHead, currentValue);
    }
    // Verify target commit exists
    const targetExists = await this.commitExists(target);
    if (!targetExists) throw new Error(`Cannot set HEAD: unknown commit ${target}`);

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.headKey(),
          Body: target,
          ContentType: "text/plain",
          IfMatch: etag ?? undefined,
        }),
      );
    } catch (e: any) {
      if (isPreconditionFailed(e)) {
        const actual = await this.readHead();
        throw new CasConflictError(priorHead, actual);
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------------
  // Commits
  // ---------------------------------------------------------------------

  async getCommit(snapshotId: SnapshotId): Promise<CommitInfo | null> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.commitKey(snapshotId) }),
      );
      const body = await streamToString(res.Body);
      return deserializeCommit(JSON.parse(body));
    } catch (e: any) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  private async commitExists(snapshotId: SnapshotId): Promise<boolean> {
    return (await this.getCommit(snapshotId)) !== null;
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
      const c = await this.getCommit(cursor);
      if (!c) break;
      result.push(c);
      cursor = c.parentId;
    }
    return result;
  }

  // ---------------------------------------------------------------------
  // Notes
  // ---------------------------------------------------------------------

  async putNote(snapshotId: SnapshotId, note: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.noteKey(snapshotId),
        Body: note,
        ContentType: "text/plain",
      }),
    );
  }

  async getNote(snapshotId: SnapshotId): Promise<string | null> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.noteKey(snapshotId) }),
      );
      return await streamToString(res.Body);
    } catch (e: any) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  // ---------------------------------------------------------------------
  // Introspection (used by doctor / GC)
  // ---------------------------------------------------------------------

  /**
   * Yield every commit's snapshotId known to the store. Used by GC to
   * discover orphans (commits whose blob is missing, etc.).
   */
  async *listCommitIds(): AsyncIterable<SnapshotId> {
    let token: string | undefined;
    const prefix = this.prefix + "commits/";
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        const id = obj.Key.slice(prefix.length);
        if (id) yield id as SnapshotId;
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }

  /**
   * Remove a commit's metadata. Caller is responsible for ensuring the
   * commit is no longer reachable from HEAD or any other reference.
   * Used by `doctor` to prune orphans.
   */
  async deleteCommit(snapshotId: SnapshotId): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.commitKey(snapshotId) }),
    );
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.noteKey(snapshotId) }),
    );
  }
}

// =====================================================================
// Helpers
// =====================================================================

const NULL_HEAD = "-";

function isNotFound(e: any): boolean {
  return e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

function isPreconditionFailed(e: any): boolean {
  return (
    e?.name === "PreconditionFailed" ||
    e?.$metadata?.httpStatusCode === 412 ||
    // Some S3-compatibles return this name
    e?.Code === "PreconditionFailed"
  );
}

async function streamToString(body: any): Promise<string> {
  if (!body) return "";
  // AWS SDK v3 Body is a Node.js Readable in Node runtime
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function serializeCommit(c: CommitInfo): Record<string, unknown> {
  return {
    snapshotId: c.snapshotId,
    contentId: c.contentId,
    parentId: c.parentId,
    trigger: c.trigger,
    message: c.message,
    authorName: c.author.name,
    authorEmail: c.author.email,
    timestamp: c.timestamp,
  };
}

function deserializeCommit(obj: any): CommitInfo {
  return {
    snapshotId: obj.snapshotId,
    contentId: (obj.contentId as ContentId | undefined) ?? undefined,
    parentId: obj.parentId ?? null,
    trigger: obj.trigger,
    message: obj.message,
    author: { name: obj.authorName, email: obj.authorEmail },
    timestamp: Number(obj.timestamp),
  };
}
