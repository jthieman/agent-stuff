import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import type { BlobStore } from "./types.ts";

export interface AzureBlockBlobClient {
  uploadData(
    data: Buffer,
    options?: {
      blobHTTPHeaders?: { blobContentType?: string };
      conditions?: { ifNoneMatch?: string };
    },
  ): Promise<unknown>;
  downloadToBuffer?(): Promise<Buffer | Uint8Array>;
  download?(): Promise<{
    readableStreamBody?: Readable;
    blobBody?: Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
  }>;
  exists(): Promise<boolean>;
  deleteIfExists?(): Promise<unknown>;
  delete?(): Promise<unknown>;
}

export interface AzureContainerClient {
  getBlockBlobClient(blobName: string): AzureBlockBlobClient;
  listBlobsFlat(options?: { prefix?: string }): AsyncIterable<{ name: string }>;
}

export interface AzureBlobServiceClient {
  getContainerClient(containerName: string): AzureContainerClient;
}

export interface AzureBlobStoreOptions {
  /** Existing Azure SDK ContainerClient. Preferred when callers manage credentials. */
  containerClient?: AzureContainerClient;
  /** Existing Azure SDK BlobServiceClient. Requires containerName. */
  serviceClient?: AzureBlobServiceClient;
  /** Container name. Required unless containerClient is provided. */
  containerName?: string;
  /** Azure Storage connection string. Requires @azure/storage-blob. */
  connectionString?: string;
  /** Blob service URL, e.g. https://account.blob.core.windows.net. */
  accountUrl?: string;
  /** Azure SDK credential, compatible with BlobServiceClient. */
  credential?: unknown;
  /** Azure SDK client options forwarded to BlobServiceClient construction. */
  clientOptions?: unknown;
  /** Blob key prefix. Default 'blobs/'. */
  prefix?: string;
}

interface AzureStorageBlobModule {
  BlobServiceClient: {
    new (url: string, credential?: unknown, options?: unknown): AzureBlobServiceClient;
    fromConnectionString(connectionString: string, options?: unknown): AzureBlobServiceClient;
  };
}

/**
 * Azure Blob Storage implementation of the BlobStore contract.
 *
 *   const blobs = new AzureBlobStore({
 *     containerName: "snapshots",
 *     connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
 *   });
 *
 * Pair with BlobBackend plus any MetadataStore, such as PostgresMetadataStore
 * or SqliteStore. Blob names use the same content-addressed layout as S3:
 *
 *   {prefix}{ab}/{cd}/{sha256}
 */
export class AzureBlobStore implements BlobStore {
  private readonly opts: AzureBlobStoreOptions;
  private readonly prefix: string;
  private containerClientPromise: Promise<AzureContainerClient> | undefined;

  constructor(opts: AzureBlobStoreOptions) {
    this.opts = opts;
    this.prefix = opts.prefix ?? "blobs/";
    if (opts.containerClient) {
      this.containerClientPromise = Promise.resolve(opts.containerClient);
    }
  }

  private keyFor(sha256: string): string {
    return `${this.prefix}${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
  }

  async put(content: Buffer): Promise<string> {
    const key = createHash("sha256").update(content).digest("hex");
    const blob = (await this.containerClient()).getBlockBlobClient(this.keyFor(key));
    try {
      await blob.uploadData(content, {
        blobHTTPHeaders: { blobContentType: "application/octet-stream" },
        conditions: { ifNoneMatch: "*" },
      });
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
    }
    return key;
  }

  async get(key: string): Promise<Buffer> {
    const blob = (await this.containerClient()).getBlockBlobClient(this.keyFor(key));
    try {
      if (blob.downloadToBuffer) return Buffer.from(await blob.downloadToBuffer());
      if (blob.download) {
        const res = await blob.download();
        if (res.readableStreamBody) return await streamToBuffer(res.readableStreamBody);
        if (res.blobBody) return Buffer.from(await (await res.blobBody).arrayBuffer());
      }
    } catch (e) {
      if (isNotFound(e)) throw new Error(`Blob not found: ${key}`);
      throw e;
    }
    throw new Error("Azure block blob client does not support downloadToBuffer() or download()");
  }

  async exists(key: string): Promise<boolean> {
    return (await this.containerClient()).getBlockBlobClient(this.keyFor(key)).exists();
  }

  async delete(key: string): Promise<void> {
    const blob = (await this.containerClient()).getBlockBlobClient(this.keyFor(key));
    try {
      if (blob.deleteIfExists) {
        await blob.deleteIfExists();
      } else if (blob.delete) {
        await blob.delete();
      } else {
        throw new Error("Azure block blob client does not support deleteIfExists() or delete()");
      }
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async *list(): AsyncIterable<string> {
    const container = await this.containerClient();
    for await (const blob of container.listBlobsFlat({ prefix: this.prefix })) {
      const fn = blob.name.split("/").pop();
      if (fn && /^[a-f0-9]{64}$/.test(fn)) yield fn;
    }
  }

  async close(): Promise<void> {
    /* Azure SDK clients do not expose a close/destroy hook. */
  }

  private containerClient(): Promise<AzureContainerClient> {
    this.containerClientPromise ??= Promise.resolve(this.createContainerClient());
    return this.containerClientPromise;
  }

  private createContainerClient(): AzureContainerClient {
    if (this.opts.containerClient) return this.opts.containerClient;

    const containerName = this.opts.containerName;
    if (!containerName) {
      throw new Error("AzureBlobStore requires containerName unless containerClient is provided");
    }

    if (this.opts.serviceClient) {
      return this.opts.serviceClient.getContainerClient(containerName);
    }

    if (!this.opts.connectionString && !this.opts.accountUrl) {
      throw new Error(
        "AzureBlobStore requires containerClient, serviceClient, connectionString, or accountUrl",
      );
    }

    const { BlobServiceClient } = loadAzureStorageBlob();
    const serviceClient = this.opts.connectionString
      ? BlobServiceClient.fromConnectionString(this.opts.connectionString, this.opts.clientOptions)
      : new BlobServiceClient(this.opts.accountUrl!, this.opts.credential, this.opts.clientOptions);
    return serviceClient.getContainerClient(containerName);
  }
}

function loadAzureStorageBlob(): AzureStorageBlobModule {
  try {
    const require = createRequire(import.meta.url);
    return require("@azure/storage-blob") as AzureStorageBlobModule;
  } catch (e: any) {
    if (e?.code === "MODULE_NOT_FOUND") {
      throw new Error(
        "AzureBlobStore requires @azure/storage-blob when no containerClient is provided",
      );
    }
    throw e;
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function isAlreadyExists(e: any): boolean {
  return (
    e?.statusCode === 409 ||
    e?.statusCode === 412 ||
    e?.code === "BlobAlreadyExists" ||
    e?.code === "ConditionNotMet" ||
    e?.details?.errorCode === "BlobAlreadyExists" ||
    e?.details?.errorCode === "ConditionNotMet"
  );
}

function isNotFound(e: any): boolean {
  return (
    e?.statusCode === 404 ||
    e?.code === "BlobNotFound" ||
    e?.code === "ContainerNotFound" ||
    e?.details?.errorCode === "BlobNotFound" ||
    e?.details?.errorCode === "ContainerNotFound"
  );
}
