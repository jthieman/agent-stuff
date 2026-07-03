/**
 * Integration tests against Azurite via testcontainers.
 *
 * Requires Docker.
 *
 *   vp test run azure.integration
 *
 * What these tests prove that the fake can't:
 *   - AzureBlobStore's SDK construction path works with a real connection string
 *   - uploadData conditional creation is accepted by Azure-compatible storage
 *   - download, delete, and listBlobsFlat use the correct SDK methods
 *   - BlobBackend can store real tar.zst archives in Azure Blob Storage
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { BlobServiceClient } from "@azure/storage-blob";
import { InMemoryFs } from "just-bash";
import { BlobBackend } from "../src/backends/blob.ts";
import { PersistentFs } from "../src/wrappers/persistent-fs.ts";
import { AzureBlobStore } from "../src/stores/azure.ts";
import { InMemoryMetadataStore } from "../src/stores/memory.ts";

const ACCOUNT = "stashacct";
const ACCOUNT_KEY = Buffer.from("just-stash-azurite-test-key").toString("base64");
const CONTAINER = "snapshots";

describe("Azure Blob / Azurite integration", () => {
  let container: StartedTestContainer;
  let connectionString: string;

  beforeAll(async () => {
    container = await new GenericContainer("mcr.microsoft.com/azure-storage/azurite:latest")
      .withEnvironment({
        AZURITE_ACCOUNTS: `${ACCOUNT}:${ACCOUNT_KEY}`,
      })
      .withCommand(["azurite-blob", "--blobHost", "0.0.0.0", "--loose", "--skipApiVersionCheck"])
      .withExposedPorts(10000)
      .withWaitStrategy(Wait.forLogMessage(/Blob service .*successfully listens/i, 1))
      .withStartupTimeout(60_000)
      .start();

    const endpoint = `http://${container.getHost()}:${container.getMappedPort(10000)}/${ACCOUNT}`;
    connectionString =
      `DefaultEndpointsProtocol=http;` +
      `AccountName=${ACCOUNT};` +
      `AccountKey=${ACCOUNT_KEY};` +
      `BlobEndpoint=${endpoint};`;

    const service = BlobServiceClient.fromConnectionString(connectionString);
    await service.getContainerClient(CONTAINER).createIfNotExists();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  }, 30_000);

  const prefix = (name: string) => `${name}/${Date.now()}-${Math.random().toString(36).slice(2)}/`;

  it("put + exists + get + delete round-trip", async () => {
    const blobs = new AzureBlobStore({
      containerName: CONTAINER,
      connectionString,
      prefix: prefix("basic"),
    });
    const content = Buffer.from("hello azurite world");

    const key = await blobs.put(content);

    expect(await blobs.exists(key)).toBe(true);
    expect((await blobs.get(key)).toString("utf8")).toBe("hello azurite world");

    await blobs.delete(key);
    expect(await blobs.exists(key)).toBe(false);
  });

  it("put is idempotent and list returns blob keys", async () => {
    const blobs = new AzureBlobStore({
      containerName: CONTAINER,
      connectionString,
      prefix: prefix("list"),
    });

    const first = await blobs.put(Buffer.from("idempotent-put-content"));
    const second = await blobs.put(Buffer.from("idempotent-put-content"));
    const third = await blobs.put(Buffer.from("other-content"));

    expect(second).toBe(first);

    const seen: string[] = [];
    for await (const key of blobs.list()) seen.push(key);
    expect(seen.sort()).toEqual([first, third].sort());
  });

  it("stores BlobBackend archives in Azure Blob Storage", async () => {
    const blobs = new AzureBlobStore({
      containerName: CONTAINER,
      connectionString,
      prefix: prefix("e2e"),
    });
    const metadata = new InMemoryMetadataStore();
    const backend = new BlobBackend({ blobs, metadata });
    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();

    await fs.writeFile("/notes.md", "# version 1");
    const c1 = await fs.commit({ trigger: "turn_end" });

    await fs.writeFile("/notes.md", "# version 2");
    const c2 = await fs.commit({ trigger: "turn_end" });

    expect(c1.contentId).toBeDefined();
    expect(c2.contentId).toBeDefined();
    expect(await blobs.exists(c1.contentId ?? c1.snapshotId)).toBe(true);
    expect(await blobs.exists(c2.contentId ?? c2.snapshotId)).toBe(true);

    await fs.rollback(c1.snapshotId);
    expect(await fs.readFile("/notes.md")).toBe("# version 1");
  });
});
