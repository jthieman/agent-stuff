/**
 * Integration tests against Gitea via testcontainers.
 *
 * Requires Docker.
 *
 *   vp test run gitea.integration
 *
 * What these tests prove that the local-clone GitBackend tests can't:
 *   - isomorphic-git's HTTP push/fetch actually work against a real
 *     git HTTP server (smart-http protocol, not git://)
 *   - The token auth callback wiring talks to the server correctly
 *   - Server-side ref checks reject diverged pushes (non-force push
 *     fails as expected, providing our CAS-at-the-push-layer property)
 *   - Fetch + restore from a fresh local cache works end-to-end —
 *     simulates "new machine boots a sandbox"
 *   - Failure modes (bad token, missing repo) produce errors we can
 *     reason about
 *
 * Gitea is ~15-30s to boot. The slowest of our integration tests.
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import * as nodeFs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryFs } from "just-bash";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import { GitBackend } from "../src/backends/git.ts";
import { PersistentFs } from "../src/wrappers/persistent-fs.ts";
import { CasConflictError } from "../src/types.ts";

const USER = "agentfs";
const PASS = "agentfs-test-password-1";
const EMAIL = "agentfs@example.test";

interface GiteaContext {
  baseUrl: string;
  token: string;
  cacheDirs: string[];
}

describe("Gitea integration", () => {
  let container: StartedTestContainer;
  let ctx: GiteaContext;

  beforeAll(async () => {
    container = await new GenericContainer("gitea/gitea:1.22")
      .withEnvironment({
        GITEA__database__DB_TYPE: "sqlite3",
        GITEA__database__PATH: "/data/gitea/gitea.db",
        GITEA__security__INSTALL_LOCK: "true",
        GITEA__server__ROOT_URL: "http://localhost:3000/",
        // Disable signup, captcha, etc. — we'll create users via CLI
        GITEA__service__DISABLE_REGISTRATION: "true",
        GITEA__service__REQUIRE_SIGNIN_VIEW: "false",
        // Run as the default git user; testcontainers handles UID mapping
        USER_UID: "1000",
        USER_GID: "1000",
      })
      .withExposedPorts(3000)
      .withWaitStrategy(Wait.forHttp("/api/v1/version", 3000))
      .withStartupTimeout(120_000)
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(3000);
    const baseUrl = `http://${host}:${port}`;

    // Create an admin user via the gitea CLI (run inside the container).
    // The first-run web setup is locked, so this is how we bootstrap.
    const createUser = await container.exec(
      [
        "gitea",
        "admin",
        "user",
        "create",
        "--username",
        USER,
        "--password",
        PASS,
        "--email",
        EMAIL,
        "--admin",
        "--must-change-password=false",
      ],
      { user: "git" },
    );
    if (createUser.exitCode !== 0) {
      throw new Error(`Failed to create gitea user: ${createUser.output}`);
    }

    // Get a personal access token via the API (basic auth as our user)
    const tokenRes = await fetch(`${baseUrl}/api/v1/users/${USER}/tokens`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "just-stash-test",
        scopes: ["write:repository", "write:user"],
      }),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new Error(`Failed to create token: ${tokenRes.status} ${body}`);
    }
    const { sha1: token } = (await tokenRes.json()) as { sha1: string };

    ctx = { baseUrl, token, cacheDirs: [] };
  }, 180_000);

  afterAll(async () => {
    for (const dir of ctx?.cacheDirs ?? []) {
      rmSync(dir, { recursive: true, force: true });
    }
    await container?.stop();
  }, 30_000);

  // --- helpers ---

  async function createRepo(repoName: string): Promise<string> {
    const res = await fetch(`${ctx.baseUrl}/api/v1/user/repos`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: repoName,
        auto_init: false, // we want an empty repo so initial push creates the ref
        private: false,
        default_branch: "main",
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to create repo ${repoName}: ${res.status} ${body}`);
    }
    return `${ctx.baseUrl}/${USER}/${repoName}.git`;
  }

  function freshCacheDir(): string {
    const d = mkdtempSync(join(tmpdir(), "gitea-test-"));
    ctx.cacheDirs.push(d);
    return d;
  }

  function makeBackend(remoteUrl: string, opts: { token?: string } = {}): GitBackend {
    return new GitBackend({
      cacheDir: freshCacheDir(),
      remote: {
        url: remoteUrl,
        username: USER,
        token: opts.token ?? ctx.token,
        http,
      },
    });
  }

  async function waitForRepoCommits(
    repoName: string,
    predicate: (commits: Array<{ sha: string; commit: { message: string } }>) => boolean,
  ): Promise<Array<{ sha: string; commit: { message: string } }>> {
    let last = "no attempts";
    for (let attempt = 0; attempt < 50; attempt++) {
      const res = await fetch(
        `${ctx.baseUrl}/api/v1/repos/${USER}/${repoName}/commits?sha=main&limit=10`,
        { headers: { Authorization: `token ${ctx.token}` } },
      );
      const body = await res.text();
      if (res.ok) {
        const commits = JSON.parse(body) as Array<{ sha: string; commit: { message: string } }>;
        if (Array.isArray(commits) && predicate(commits)) return commits;
        last = body;
      } else {
        last = `${res.status} ${body}`;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${repoName} commits: ${last}`);
  }

  // --- tests ---

  it("initial push: commit lands on the remote", async () => {
    const url = await createRepo("test-initial-push");
    const backend = makeBackend(url);
    await backend.initialize();

    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();
    await fs.writeFile("/README.md", "# from just-stash");
    const info = await fs.commit({ trigger: "first" });

    // Verify the commit exists on the server via API
    const commits = await waitForRepoCommits(
      "test-initial-push",
      (commits) => commits.length === 1 && commits[0]?.sha === info.snapshotId,
    );
    expect(commits[0].sha).toBe(info.snapshotId);
  });

  it("fetch + restore: fresh cache pulls history from the remote", async () => {
    // Setup: push some commits with backend A
    const url = await createRepo("test-fetch-restore");
    const backendA = makeBackend(url);
    await backendA.initialize();

    const fsA = new PersistentFs(new InMemoryFs(), { backend: backendA });
    await fsA.boot();
    await fsA.writeFile("/notes.md", "version 1");
    await fsA.commit({ trigger: "first" });
    await fsA.writeFile("/notes.md", "version 2");
    const c2 = await fsA.commit({ trigger: "second" });

    await waitForRepoCommits("test-fetch-restore", (commits) =>
      commits.some((commit) => commit.sha === c2.snapshotId),
    );

    // Now: a fresh backend pointing at the same remote (different cacheDir)
    // simulates a new machine acquiring the sandbox.
    const backendB = makeBackend(url);
    let fetchedHead = await backendB.readHead();
    for (let attempt = 0; fetchedHead !== c2.snapshotId && attempt < 50; attempt++) {
      await backendB.initialize();
      fetchedHead = await backendB.readHead();
      if (fetchedHead !== c2.snapshotId) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    expect(fetchedHead).toBe(c2.snapshotId);

    const fsB = new PersistentFs(new InMemoryFs(), { backend: backendB });
    await fsB.boot();
    const content = await fsB.readFile("/notes.md");
    expect(content).toBe("version 2");
  }, 30_000);

  it("reused remote backend fetches the latest head before boot", async () => {
    const url = await createRepo("test-reused-backend-fetches-before-boot");
    const backendA = makeBackend(url);
    const backendB = makeBackend(url);
    await backendA.initialize();
    await backendB.initialize();

    const fsA = new PersistentFs(new InMemoryFs(), { backend: backendA });
    const fsB = new PersistentFs(new InMemoryFs(), { backend: backendB });

    await fsA.boot();
    await fsA.writeFile("/notes.md", "version 1");
    const c1 = await fsA.commit({ trigger: "first" });
    await waitForRepoCommits(
      "test-reused-backend-fetches-before-boot",
      (commits) => commits[0]?.sha === c1.snapshotId,
    );

    await fsB.boot();
    expect(await fsB.readFile("/notes.md")).toBe("version 1");

    await fsA.writeFile("/notes.md", "version 2");
    const c2 = await fsA.commit({ trigger: "second" });
    await waitForRepoCommits(
      "test-reused-backend-fetches-before-boot",
      (commits) => commits[0]?.sha === c2.snapshotId,
    );

    await fsB.boot();
    expect(await fsB.readFile("/notes.md")).toBe("version 2");
    expect(await backendB.readHead()).toBe(c2.snapshotId);
  }, 30_000);

  it("git notes are pushed and fetched with remote-backed backends", async () => {
    const url = await createRepo("test-remote-notes");
    const backendA = makeBackend(url);
    await backendA.initialize();

    const fsA = new PersistentFs(new InMemoryFs(), { backend: backendA });
    await fsA.boot();
    await fsA.writeFile("/x.txt", "x");
    const c = await fsA.commit({
      trigger: "with-note",
      note: "prompt: write x. response: done.",
    });
    await waitForRepoCommits("test-remote-notes", (commits) => commits[0]?.sha === c.snapshotId);

    const backendB = makeBackend(url);
    await backendB.initialize();

    await expect(backendB.getNote(c.snapshotId)).resolves.toBe("prompt: write x. response: done.");
  }, 30_000);

  it("concurrent push: server-side ref check rejects the loser", async () => {
    const url = await createRepo("test-concurrent-push");

    // Two backends with separate cache dirs but the same remote.
    // Both initialize against the empty remote, both make a local
    // commit, both try to push. One push succeeds, the other fails
    // because the remote ref has advanced.
    const backendA = makeBackend(url);
    const backendB = makeBackend(url);
    await backendA.initialize();
    await backendB.initialize();

    const fsA = new PersistentFs(new InMemoryFs(), { backend: backendA });
    const fsB = new PersistentFs(new InMemoryFs(), { backend: backendB });
    await fsA.boot();
    await fsB.boot();

    await fsA.writeFile("/who.txt", "A");
    await fsB.writeFile("/who.txt", "B");

    // Sequence to force a real race: A commits and pushes first; then
    // B tries to push without re-fetching. B's local priorHead matches
    // its OWN local cache (null) but the remote has advanced.
    const aCommit = await fsA.commit({ trigger: "A-wins" });

    // B's commit will: pass local CAS (local priorHead matches local
    // HEAD which is still null), build the commit, try to push, and
    // the push should fail because the remote ref now points at A's
    // commit, not at B's expected parent.
    await expect(fsB.commit({ trigger: "B-loses" })).rejects.toThrow(CasConflictError);
    expect(await backendB.readHead()).toBe(aCommit.snapshotId);

    // Sanity: the server has exactly one commit
    const commits = await waitForRepoCommits(
      "test-concurrent-push",
      (commits) => commits.length === 1 && commits[0]?.commit.message.includes("A-wins"),
    );
    expect(commits.length).toBe(1);
    expect(commits[0].commit.message).toContain("A-wins");
  });

  it("remote rollback moves the branch back when the remote still matches priorHead", async () => {
    const url = await createRepo("test-remote-rollback");
    const backend = makeBackend(url);
    await backend.initialize();

    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();
    await fs.writeFile("/v.txt", "v1");
    const c1 = await fs.commit({ trigger: "first" });
    await fs.writeFile("/v.txt", "v2");
    const c2 = await fs.commit({ trigger: "second" });

    await waitForRepoCommits(
      "test-remote-rollback",
      (commits) => commits[0]?.sha === c2.snapshotId,
    );

    await fs.rollback(c1.snapshotId);

    const commits = await waitForRepoCommits(
      "test-remote-rollback",
      (commits) => commits.length === 1 && commits[0]?.sha === c1.snapshotId,
    );
    expect(commits[0].sha).toBe(c1.snapshotId);
    expect(await backend.readHead()).toBe(c1.snapshotId);
  });

  it("remote rollback conflict observes remote truth before rewriting local HEAD", async () => {
    const url = await createRepo("test-remote-rollback-conflict");
    const backendA = makeBackend(url);
    await backendA.initialize();

    const fsA = new PersistentFs(new InMemoryFs(), { backend: backendA });
    await fsA.boot();
    await fsA.writeFile("/v.txt", "v1");
    const c1 = await fsA.commit({ trigger: "first" });
    await fsA.writeFile("/v.txt", "v2");
    const c2 = await fsA.commit({ trigger: "second" });
    await waitForRepoCommits(
      "test-remote-rollback-conflict",
      (commits) => commits[0]?.sha === c2.snapshotId,
    );

    const backendB = makeBackend(url);
    await backendB.initialize();
    expect(await backendB.readHead()).toBe(c2.snapshotId);

    await fsA.writeFile("/v.txt", "v3");
    const c3 = await fsA.commit({ trigger: "third" });
    await waitForRepoCommits(
      "test-remote-rollback-conflict",
      (commits) => commits[0]?.sha === c3.snapshotId,
    );

    await expect(backendB.rollback(c1.snapshotId, c2.snapshotId)).rejects.toThrow(CasConflictError);
    const localHead = await git.resolveRef({
      fs: nodeFs,
      gitdir: (backendB as any).gitdir,
      ref: "main",
    });
    expect(localHead).toBe(c3.snapshotId);
    expect(await backendB.readHead()).toBe(c3.snapshotId);

    const backendC = makeBackend(url);
    await backendC.initialize();
    expect(await backendC.readHead()).toBe(c3.snapshotId);
  });

  it("bad token: auth failure surfaces on first push", async () => {
    const url = await createRepo("test-bad-token");
    const backend = makeBackend(url, { token: "definitely-not-a-real-token" });
    await backend.initialize();

    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();
    await fs.writeFile("/x.txt", "x");
    // Push will fail with auth error. Verify it throws something
    // recognizable (isomorphic-git surfaces HttpError or similar).
    await expect(fs.commit({ trigger: "t" })).rejects.toThrow();
  });

  it("missing repo: URL pointing at a non-existent repo errors clearly", async () => {
    const url = `${ctx.baseUrl}/${USER}/this-repo-does-not-exist.git`;
    const backend = makeBackend(url);
    await expect(backend.initialize()).rejects.toThrow();
  });

  it("many commits in sequence: chain integrity over real HTTP", async () => {
    const url = await createRepo("test-many-commits");
    const backend = makeBackend(url);
    await backend.initialize();

    const fs = new PersistentFs(new InMemoryFs(), { backend });
    await fs.boot();

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(`/file-${i}.txt`, `v${i}`);
      const c = await fs.commit({ trigger: `c${i}` });
      ids.push(c.snapshotId);
    }

    // Verify chain on remote
    const commits = await waitForRepoCommits(
      "test-many-commits",
      (commits) => commits.length === 5 && commits[0]?.sha === ids[4],
    );
    expect(commits.length).toBe(5);
    // Server returns newest-first
    expect(commits.map((c) => c.sha)).toEqual([...ids].reverse());

    // verifyIntegrity walks via real HTTP getCommit calls
    let cursor = await backend.readHead();
    let count = 0;
    while (cursor !== null) {
      const c = await backend.getCommit(cursor);
      expect(c).not.toBeNull();
      count++;
      cursor = c!.parentId;
    }
    expect(count).toBe(5);
  });
});
