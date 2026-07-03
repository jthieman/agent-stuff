import { describe, it, expect } from "vite-plus/test";
import { AzureBlobStore } from "../src/stores/azure.ts";
import type { AzureBlockBlobClient, AzureContainerClient } from "../src/stores/azure.ts";

class FakeContainerClient implements AzureContainerClient {
  readonly blobs = new Map<string, Buffer>();
  readonly uploads: string[] = [];
  readonly deletes: string[] = [];

  getBlockBlobClient(blobName: string): AzureBlockBlobClient {
    return new FakeBlockBlobClient(this, blobName);
  }

  async *listBlobsFlat(opts?: { prefix?: string }): AsyncIterable<{ name: string }> {
    for (const name of this.blobs.keys()) {
      if (!opts?.prefix || name.startsWith(opts.prefix)) yield { name };
    }
  }
}

class FakeBlockBlobClient implements AzureBlockBlobClient {
  constructor(
    private readonly container: FakeContainerClient,
    private readonly name: string,
  ) {}

  async uploadData(data: Buffer, opts?: { conditions?: { ifNoneMatch?: string } }): Promise<void> {
    this.container.uploads.push(this.name);
    if (opts?.conditions?.ifNoneMatch === "*" && this.container.blobs.has(this.name)) {
      const error: any = new Error("condition not met");
      error.statusCode = 412;
      error.code = "ConditionNotMet";
      throw error;
    }
    this.container.blobs.set(this.name, Buffer.from(data));
  }

  async downloadToBuffer(): Promise<Buffer> {
    const content = this.container.blobs.get(this.name);
    if (!content) {
      const error: any = new Error("not found");
      error.statusCode = 404;
      error.code = "BlobNotFound";
      throw error;
    }
    return Buffer.from(content);
  }

  async exists(): Promise<boolean> {
    return this.container.blobs.has(this.name);
  }

  async deleteIfExists(): Promise<void> {
    this.container.deletes.push(this.name);
    this.container.blobs.delete(this.name);
  }
}

describe("AzureBlobStore", () => {
  it("prefixes content-addressed keys and implements basic BlobStore operations", async () => {
    const containerClient = new FakeContainerClient();
    const store = new AzureBlobStore({
      containerClient,
      prefix: "tenant-a/blobs/",
    });

    const key = await store.put(Buffer.from("hello azure"));
    const expectedName = `tenant-a/blobs/${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`;

    expect(containerClient.uploads).toEqual([expectedName]);
    expect(await store.exists(key)).toBe(true);
    expect((await store.get(key)).toString("utf8")).toBe("hello azure");

    const listed: string[] = [];
    for await (const listedKey of store.list()) listed.push(listedKey);
    expect(listed).toEqual([key]);

    await store.delete(key);
    expect(containerClient.deletes).toEqual([expectedName]);
    expect(await store.exists(key)).toBe(false);
  });

  it("treats an existing content-addressed blob as an idempotent put", async () => {
    const containerClient = new FakeContainerClient();
    const store = new AzureBlobStore({ containerClient });
    const content = Buffer.from("same content");

    const first = await store.put(content);
    const second = await store.put(content);

    expect(second).toBe(first);
    expect(containerClient.uploads.length).toBe(2);
    expect(await store.exists(first)).toBe(true);
  });
});
