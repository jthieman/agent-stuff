import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash, randomBytes } from "node:crypto";
import { createZstdCompress, createZstdDecompress, constants } from "node:zlib";
import * as tar from "tar-stream";
import type { IFileSystem } from "just-bash";
import type { SnapshotBackend } from "../backend.ts";
import type { SnapshotId, ContentId, CommitInfo, CommitMetadata, DiffEntry } from "../types.ts";
import { walkSnapshot } from "../walk.ts";
import { resolveArchiveEntryPath, isSafeEntryType } from "../path-safety.ts";
import type { BlobStore, MetadataStore } from "../stores/types.ts";

/**
 * Deterministic mtime for tar entries. Without this, identical content
 * produces different archive bytes (current time differs), defeating
 * content-addressed dedup.
 */
const EPOCH = new Date(0);

export interface BlobBackendOptions {
  blobs: BlobStore;
  metadata: MetadataStore;
}

/**
 * Snapshot backend that stores tar.zst archives in a BlobStore and
 * commit metadata in a MetadataStore.
 *
 *   const backend = new BlobBackend({
 *     blobs: new S3BlobStore({ bucket }),
 *     metadata: new PostgresMetadataStore({ pool }),
 *   });
 *
 * Each commit:
 *   1. Walks the inner fs (skipping excludePaths and symlinks)
 *   2. Builds a tar.zst archive in memory
 *   3. Stores the archive in BlobStore (returns content SHA-256)
 *   4. Creates a distinct commit id and appends a commit row with CAS
 *
 * Restoring is symmetric — resolve the commit's content id, fetch the blob, extract.
 */
export class BlobBackend implements SnapshotBackend {
  private readonly blobs: BlobStore;
  private readonly metadata: MetadataStore;

  constructor(opts: BlobBackendOptions) {
    this.blobs = opts.blobs;
    this.metadata = opts.metadata;
  }

  // --- Lifecycle ---

  async close(): Promise<void> {
    await this.blobs.close();
    await this.metadata.close();
  }

  // --- HEAD ---

  readHead(): Promise<SnapshotId | null> {
    return this.metadata.readHead();
  }

  // --- Commit ---

  async commit(opts: {
    fs: IFileSystem;
    excludePaths: string[];
    priorHead: SnapshotId | null;
    metadata: CommitMetadata;
  }): Promise<CommitInfo> {
    const archive = await buildArchive(opts.fs, opts.excludePaths);
    const contentId = (await this.blobs.put(archive)) as ContentId;
    const snapshotId = createBlobCommitId({
      contentId,
      parentId: opts.priorHead,
      metadata: opts.metadata,
    });

    const commit: CommitInfo = {
      snapshotId,
      contentId,
      parentId: opts.priorHead,
      trigger: opts.metadata.trigger,
      message: opts.metadata.message,
      author: opts.metadata.author,
      timestamp: opts.metadata.timestamp,
    };

    await this.metadata.appendCommit({ commit, priorHead: opts.priorHead });
    return commit;
  }

  // --- Restore ---

  async restore(snapshotId: SnapshotId, into: IFileSystem): Promise<void> {
    const archive = await this.blobs.get(await this.contentIdFor(snapshotId));
    await extractArchive(archive, into);
  }

  // --- Rollback ---

  rollback(target: SnapshotId, priorHead: SnapshotId): Promise<void> {
    return this.metadata.setHead(target, priorHead);
  }

  // --- Lookup ---

  getCommit(snapshotId: SnapshotId): Promise<CommitInfo | null> {
    return this.metadata.getCommit(snapshotId);
  }

  // --- Log ---

  log(opts?: { limit?: number; since?: SnapshotId }): Promise<CommitInfo[]> {
    return this.metadata.log(opts);
  }

  // --- Diff ---

  async diff(from: SnapshotId, to?: SnapshotId): Promise<DiffEntry[]> {
    const toId = to ?? (await this.metadata.readHead());
    if (!toId) throw new Error("Cannot diff: no HEAD");

    const fromManifest = await this.readManifest(from);
    const toManifest = await this.readManifest(toId);
    return diffManifests(fromManifest, toManifest);
  }

  // --- Notes ---

  addNote(snapshotId: SnapshotId, note: string): Promise<void> {
    return this.metadata.putNote(snapshotId, note);
  }
  getNote(snapshotId: SnapshotId): Promise<string | null> {
    return this.metadata.getNote(snapshotId);
  }

  // --- Internal: read tar manifest (paths + sizes) without extracting ---

  private async readManifest(
    snapshotId: SnapshotId,
  ): Promise<Map<string, { size: number; sha256: string }>> {
    const archive = await this.blobs.get(await this.contentIdFor(snapshotId));
    const manifest = new Map<string, { size: number; sha256: string }>();
    const extract = tar.extract();

    extract.on("entry", (header, stream, next) => {
      if (header.type !== "file") {
        stream.resume();
        next();
        return;
      }

      const hash = createHash("sha256");
      stream.on("data", (chunk: Buffer) => {
        hash.update(chunk);
      });
      stream.on("end", () => {
        manifest.set(header.name, {
          size: header.size ?? 0,
          sha256: hash.digest("hex"),
        });
        next();
      });
    });

    const decompress = createZstdDecompress();
    await pipeline(Readable.from(archive), decompress, extract);
    return manifest;
  }

  private async contentIdFor(snapshotId: SnapshotId): Promise<string> {
    const commit = await this.metadata.getCommit(snapshotId);
    return commit?.contentId ?? snapshotId;
  }
}

// ---------------------------------------------------------------------------
// Tar.zst archive build / extract
// ---------------------------------------------------------------------------

async function buildArchive(fs: IFileSystem, excludePaths: string[]): Promise<Buffer> {
  const pack = tar.pack();

  // Stream pack → zstd → buffer
  const compress = createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: 3 } });
  const chunks: Buffer[] = [];
  const collect = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const pipelinePromise = pipeline(pack, compress, collect);

  await walkSnapshot(fs, "/", excludePaths, async (entry) => {
    const relName = entry.path.slice(1); // strip leading '/'
    if (entry.isDirectory) {
      pack.entry({ name: relName + "/", type: "directory", mtime: EPOCH });
    } else if (entry.isFile) {
      const content = await fs.readFileBuffer(entry.path);
      await new Promise<void>((resolve, reject) => {
        const entryStream = pack.entry(
          { name: relName, type: "file", size: content.byteLength, mtime: EPOCH },
          (err) => (err ? reject(err) : resolve()),
        );
        entryStream.write(content);
        entryStream.end();
      });
    }
  });

  pack.finalize();
  await pipelinePromise;
  return Buffer.concat(chunks);
}

async function extractArchive(archive: Buffer, into: IFileSystem): Promise<void> {
  const extract = tar.extract();
  const operations: Promise<void>[] = [];

  extract.on("entry", (header, stream, next) => {
    if (!isSafeEntryType(header.type)) {
      stream.resume();
      next();
      return;
    }
    const safePath = resolveArchiveEntryPath("/", header.name);
    if (!safePath) {
      stream.resume();
      next();
      return;
    }

    if (header.type === "directory") {
      operations.push(into.mkdir(safePath, { recursive: true }));
      stream.resume();
      next();
    } else if (header.type === "file") {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        const content = Buffer.concat(chunks);
        const parent = safePath.split("/").slice(0, -1).join("/") || "/";
        operations.push(
          (async () => {
            if (parent !== "/") await into.mkdir(parent, { recursive: true });
            await into.writeFile(safePath, content);
          })(),
        );
        next();
      });
    } else {
      stream.resume();
      next();
    }
  });

  const decompress = createZstdDecompress();
  await pipeline(Readable.from(archive), decompress, extract);
  await Promise.all(operations);
}

function diffManifests(
  from: Map<string, { size: number; sha256: string }>,
  to: Map<string, { size: number; sha256: string }>,
): DiffEntry[] {
  const result: DiffEntry[] = [];
  // Use leading slash for output paths
  const norm = (p: string) => "/" + p;

  for (const [path, file] of to) {
    const fromFile = from.get(path);
    if (fromFile === undefined) result.push({ path: norm(path), kind: "added" });
    else if (fromFile.sha256 !== file.sha256) result.push({ path: norm(path), kind: "modified" });
  }
  for (const path of from.keys()) {
    if (!to.has(path)) result.push({ path: norm(path), kind: "removed" });
  }
  result.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

function createBlobCommitId(opts: {
  contentId: ContentId;
  parentId: SnapshotId | null;
  metadata: CommitMetadata;
}): SnapshotId {
  const canonical = JSON.stringify({
    v: 1,
    contentId: opts.contentId,
    parentId: opts.parentId,
    trigger: opts.metadata.trigger,
    message: opts.metadata.message,
    author: {
      name: opts.metadata.author.name,
      email: opts.metadata.author.email,
    },
    timestamp: opts.metadata.timestamp,
    nonce: randomBytes(16).toString("hex"),
  });
  return createHash("sha256")
    .update("just-stash:blob-commit\0")
    .update(canonical)
    .digest("hex") as SnapshotId;
}
