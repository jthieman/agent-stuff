import { createHash } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { BlobStore } from "./types.ts";

export interface S3BlobStoreOptions {
  bucket: string;
  region?: string;
  /** S3-compatible endpoint (MinIO, R2, Tigris). Enables forcePathStyle. */
  endpoint?: string;
  /** Key prefix. Default 'blobs/'. */
  prefix?: string;
  /** Pre-built S3 client; constructor builds one from the other options if omitted. */
  s3Client?: S3Client;
}

/**
 * S3 (and S3-compatible) blob store. Pair with any MetadataStore.
 *
 *   const blobs = new S3BlobStore({ bucket: 'my-bucket' });
 *   const meta = new PostgresMetadataStore({ pool });
 *   const backend = new BlobBackend({ blobs, metadata: meta });
 *
 * S3 key layout:
 *   {prefix}{ab}/{cd}/{sha256}
 *
 * Two-level hash partition for fast ListObjectsV2 paging.
 */
export class S3BlobStore implements BlobStore {
  private readonly s3: S3Client;
  private readonly ownsClient: boolean;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(opts: S3BlobStoreOptions) {
    this.bucket = opts.bucket;
    this.prefix = opts.prefix ?? "blobs/";
    this.ownsClient = !opts.s3Client;
    this.s3 =
      opts.s3Client ??
      new S3Client({
        region: opts.region ?? "us-east-1",
        endpoint: opts.endpoint,
        forcePathStyle: !!opts.endpoint,
      });
  }

  private keyFor(sha256: string): string {
    return `${this.prefix}${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
  }

  async put(content: Buffer): Promise<string> {
    const key = createHash("sha256").update(content).digest("hex");
    // Conditional create: succeed only if the object doesn't exist yet.
    // If two writers race with the same content (which they will, since
    // content addressing means same content → same key), one wins, the
    // other gets PreconditionFailed which we treat as success.
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.keyFor(key),
          Body: content,
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
        }),
      );
    } catch (e: any) {
      if (
        e?.name === "PreconditionFailed" ||
        e?.$metadata?.httpStatusCode === 412 ||
        e?.Code === "PreconditionFailed"
      ) {
        // Object already exists with same content (content-addressed).
        // Treat as success.
      } else {
        throw e;
      }
    }
    return key;
  }

  async get(key: string): Promise<Buffer> {
    let res: any;
    try {
      res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.keyFor(key) }),
      );
    } catch (e) {
      if (isNotFound(e)) throw new Error(`Blob not found: ${key}`);
      throw e;
    }
    if (!res.Body) throw new Error(`Blob not found: ${key}`);
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.keyFor(key) }));
      return true;
    } catch (e: any) {
      if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) return false;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.keyFor(key) }));
  }

  async *list(): AsyncIterable<string> {
    let token: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        const fn = obj.Key.split("/").pop();
        if (fn && /^[a-f0-9]{64}$/.test(fn)) yield fn;
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }

  async close(): Promise<void> {
    if (this.ownsClient) this.s3.destroy();
  }
}

function isNotFound(e: any): boolean {
  return (
    e?.name === "NoSuchKey" ||
    e?.name === "NotFound" ||
    e?.Code === "NoSuchKey" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

// ---------------------------------------------------------------------------
// S3MetadataStore — re-exported here so callers can do:
//   import { S3BlobStore, S3MetadataStore } from "just-stash/s3";
// ---------------------------------------------------------------------------
export { S3MetadataStore } from "./s3-metadata.ts";
export type { S3MetadataStoreOptions } from "./s3-metadata.ts";
