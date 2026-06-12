import { describe, it, expect, beforeEach } from "vite-plus/test";
import { CloudflareArtifacts, CloudflareArtifactsError } from "../src/cloudflare-artifacts.ts";

/**
 * Mock fetch that records calls and returns canned responses based on
 * (method, path) tuples. Simulates the Artifacts REST API envelope.
 */
class MockFetch {
  recorded: Array<{ method: string; url: string; body: any; headers: Record<string, string> }> = [];
  routes: Map<string, (body: any) => { status: number; envelope: any }> = new Map();

  on(
    method: string,
    pathPattern: string,
    handler: (body: any) => { status: number; envelope: any },
  ): this {
    this.routes.set(`${method} ${pathPattern}`, handler);
    return this;
  }

  asFetch(): typeof globalThis.fetch {
    return (async (input: any, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.url;
      const method = init?.method ?? "GET";
      const bodyStr = typeof init?.body === "string" ? init.body : null;
      const body = bodyStr ? JSON.parse(bodyStr) : undefined;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      this.recorded.push({ method, url, body, headers });

      // Match by stripping query strings, looking up by pattern
      const pathPart = new URL(url).pathname.split("/v1/api/namespaces/")[1] ?? "";
      const path = "/" + pathPart.split("/").slice(1).join("/");

      // Try exact match first, then pattern matches with :param
      for (const [key, handler] of this.routes) {
        const [m, p] = key.split(" ");
        if (m !== method) continue;
        const matches = matchPath(p, path);
        if (matches) {
          const { status, envelope } = handler(body);
          return new Response(JSON.stringify(envelope), {
            status,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return new Response(
        JSON.stringify({
          result: null,
          success: false,
          errors: [{ code: 404, message: `No mock for ${method} ${path}` }],
        }),
        { status: 404 },
      );
    }) as typeof globalThis.fetch;
  }
}

function matchPath(pattern: string, actual: string): boolean {
  const patternParts = pattern.split("?")[0].split("/");
  const actualParts = actual.split("?")[0].split("/");
  if (patternParts.length !== actualParts.length) return false;
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) continue;
    if (patternParts[i] !== actualParts[i]) return false;
  }
  return true;
}

function envelope<T>(result: T) {
  return { result, success: true, errors: [], messages: [] };
}

function errorEnvelope(code: number, message: string) {
  return { result: null, success: false, errors: [{ code, message }], messages: [] };
}

// ---------------------------------------------------------------------

describe("CloudflareArtifacts", () => {
  let mock: MockFetch;
  let cf: CloudflareArtifacts;

  beforeEach(() => {
    mock = new MockFetch();
    cf = new CloudflareArtifacts({
      apiToken: "test-api-token",
      namespace: "agentfs-test",
      fetch: mock.asFetch(),
    });
  });

  describe("createRepo", () => {
    it("POSTs /repos with the name and returns the repo + token", async () => {
      mock.on("POST", "/repos", () => ({
        status: 200,
        envelope: envelope({
          id: "repo_abc",
          name: "alice",
          description: null,
          default_branch: "main",
          remote: "https://acct.artifacts.cloudflare.net/git/agentfs-test/alice.git",
          token: "art_v1_secret?expires=1234567890",
          expires_at: "2026-06-13T00:00:00Z",
        }),
      }));

      const r = await cf.createRepo("alice");
      expect(r.name).toBe("alice");
      expect(r.remote).toContain("alice.git");
      expect(r.token).toMatch(/^art_v1_/);

      // Verify the request shape
      expect(mock.recorded).toHaveLength(1);
      const req = mock.recorded[0];
      expect(req.method).toBe("POST");
      expect(req.url).toBe("https://artifacts.cloudflare.net/v1/api/namespaces/agentfs-test/repos");
      expect(req.body).toEqual({ name: "alice" });
      expect((req.headers as any)["Authorization"]).toBe("Bearer test-api-token");
    });

    it("passes through optional fields", async () => {
      mock.on("POST", "/repos", (body) => ({
        status: 200,
        envelope: envelope({
          id: "r1",
          name: body.name,
          description: body.description,
          default_branch: body.default_branch ?? "main",
          remote: "https://x.cloudflare.net/git/r/r1.git",
          token: "t",
          expires_at: "2026-01-01T00:00:00Z",
        }),
      }));
      await cf.createRepo("alice", {
        description: "test repo",
        default_branch: "trunk",
        read_only: false,
      });
      expect(mock.recorded[0].body).toEqual({
        name: "alice",
        description: "test repo",
        default_branch: "trunk",
        read_only: false,
      });
    });
  });

  describe("getRepo", () => {
    it("GETs /repos/:name", async () => {
      mock.on("GET", "/repos/:name", () => ({
        status: 200,
        envelope: envelope({
          id: "r1",
          name: "alice",
          description: null,
          default_branch: "main",
          created_at: "",
          updated_at: "",
          last_push_at: null,
          source: null,
          read_only: false,
          remote: "https://x.cloudflare.net/git/agentfs-test/alice.git",
        }),
      }));
      const r = await cf.getRepo("alice");
      expect(r.name).toBe("alice");
      expect(mock.recorded[0].method).toBe("GET");
    });

    it("throws CloudflareArtifactsError on 404", async () => {
      mock.on("GET", "/repos/:name", () => ({
        status: 404,
        envelope: errorEnvelope(404, "Repo not found"),
      }));
      try {
        await cf.getRepo("ghost");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(CloudflareArtifactsError);
        expect((e as CloudflareArtifactsError).status).toBe(404);
      }
    });
  });

  describe("forkRepo", () => {
    it("POSTs /repos/:name/fork with the new name", async () => {
      mock.on("POST", "/repos/:name/fork", (body) => ({
        status: 200,
        envelope: envelope({
          id: "r2",
          name: body.name,
          description: null,
          default_branch: "main",
          remote: `https://x.cloudflare.net/git/agentfs-test/${body.name}.git`,
          token: "fork-token",
          expires_at: "2026-01-01T00:00:00Z",
          objects: 42,
        }),
      }));
      const r = await cf.forkRepo("alice", { name: "alice-fork", default_branch_only: true });
      expect(r.name).toBe("alice-fork");
      expect(r.objects).toBe(42);
      expect(mock.recorded[0].url).toContain("/repos/alice/fork");
      expect(mock.recorded[0].body).toEqual({ name: "alice-fork", default_branch_only: true });
    });
  });

  describe("importRepo", () => {
    it("POSTs /repos/:name/import with the source URL", async () => {
      mock.on("POST", "/repos/:name/import", (_body) => ({
        status: 200,
        envelope: envelope({
          id: "r3",
          name: "react-mirror",
          description: null,
          default_branch: "main",
          remote: "https://x.cloudflare.net/git/agentfs-test/react-mirror.git",
          token: "import-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
      }));
      const r = await cf.importRepo("react-mirror", {
        url: "https://github.com/facebook/react",
        branch: "main",
        depth: 100,
      });
      expect(r.name).toBe("react-mirror");
      expect(mock.recorded[0].body).toEqual({
        url: "https://github.com/facebook/react",
        branch: "main",
        depth: 100,
      });
    });
  });

  describe("deleteRepo", () => {
    it("DELETEs /repos/:name", async () => {
      mock.on("DELETE", "/repos/:name", () => ({
        status: 202,
        envelope: envelope({ id: "r1" }),
      }));
      await cf.deleteRepo("alice");
      expect(mock.recorded[0].method).toBe("DELETE");
      expect(mock.recorded[0].url).toContain("/repos/alice");
    });
  });

  describe("createToken", () => {
    it("POSTs /tokens with repo + scope + ttl", async () => {
      mock.on("POST", "/tokens", () => ({
        status: 200,
        envelope: envelope({
          id: "tok_1",
          plaintext: "art_v1_newsecret",
          scope: "write",
          expires_at: "2026-06-13T00:00:00Z",
        }),
      }));
      const t = await cf.createToken("alice", { scope: "read", ttl: 3600 });
      expect(t.plaintext).toBe("art_v1_newsecret");
      expect(mock.recorded[0].body).toEqual({ repo: "alice", scope: "read", ttl: 3600 });
    });
  });

  describe("listRepos", () => {
    it("GETs /repos with query params", async () => {
      mock.on("GET", "/repos", () => ({
        status: 200,
        envelope: {
          ...envelope([
            {
              id: "r1",
              name: "alice",
              description: null,
              default_branch: "main",
              created_at: "",
              updated_at: "",
              last_push_at: null,
              source: null,
              read_only: false,
            },
          ]),
          result_info: { cursor: "next", per_page: 20, count: 1 },
        },
      }));
      const r = await cf.listRepos({ limit: 20, sort: "updated_at", direction: "desc" });
      expect(r).toHaveLength(1);
      expect(r[0].name).toBe("alice");
      expect(mock.recorded[0].url).toMatch(/limit=20/);
      expect(mock.recorded[0].url).toMatch(/sort=updated_at/);
    });
  });

  describe("createBackend (the high-level convenience)", () => {
    it("creates the repo when it does not exist and returns a configured backend", async () => {
      mock.on("GET", "/repos/:name", () => ({
        status: 404,
        envelope: errorEnvelope(404, "not found"),
      }));
      mock.on("POST", "/repos", () => ({
        status: 200,
        envelope: envelope({
          id: "r1",
          name: "alice",
          description: null,
          default_branch: "main",
          created_at: "2026-06-13T00:00:00Z",
          updated_at: "2026-06-13T00:01:00Z",
          last_push_at: null,
          source: "template",
          read_only: false,
          remote: "https://acct.artifacts.cloudflare.net/git/agentfs-test/alice.git",
          token: "art_v1_initial",
          expires_at: "2026-06-13T00:00:00Z",
        }),
      }));

      const { backend, repo, token, expiresAt } = await cf.createBackend("alice", {
        cacheDir: "/tmp/cache-alice",
      });
      expect(repo.name).toBe("alice");
      expect(repo.created_at).toBe("2026-06-13T00:00:00Z");
      expect(repo.updated_at).toBe("2026-06-13T00:01:00Z");
      expect(repo.last_push_at).toBeNull();
      expect(repo.source).toBe("template");
      expect(repo.read_only).toBe(false);
      expect(token).toBe("art_v1_initial");
      expect(expiresAt).toBe("2026-06-13T00:00:00Z");
      expect(backend).toBeDefined();

      // Verify the GET happened first, then POST /repos
      expect(
        mock.recorded.map(
          (r) => `${r.method} ${new URL(r.url).pathname.split("namespaces/agentfs-test")[1]}`,
        ),
      ).toEqual(["GET /repos/alice", "POST /repos"]);
    });

    it("uses existing repo + mints a fresh token when repo exists", async () => {
      mock.on("GET", "/repos/:name", () => ({
        status: 200,
        envelope: envelope({
          id: "r1",
          name: "alice",
          description: null,
          default_branch: "main",
          created_at: "",
          updated_at: "",
          last_push_at: null,
          source: null,
          read_only: false,
          remote: "https://acct.artifacts.cloudflare.net/git/agentfs-test/alice.git",
        }),
      }));
      mock.on("POST", "/tokens", () => ({
        status: 200,
        envelope: envelope({
          id: "tok_2",
          plaintext: "art_v1_fresh",
          scope: "write",
          expires_at: "2026-06-14T00:00:00Z",
        }),
      }));

      const { token, expiresAt } = await cf.createBackend("alice", {
        cacheDir: "/tmp/cache-alice",
      });
      expect(token).toBe("art_v1_fresh");
      expect(expiresAt).toBe("2026-06-14T00:00:00Z");

      const calls = mock.recorded.map((r) => r.method);
      expect(calls).toEqual(["GET", "POST"]);
    });

    it("ensureRepo: false throws when repo missing", async () => {
      mock.on("GET", "/repos/:name", () => ({
        status: 404,
        envelope: errorEnvelope(404, "not found"),
      }));
      await expect(
        cf.createBackend("ghost", { cacheDir: "/tmp/cache", ensureRepo: false }),
      ).rejects.toBeInstanceOf(CloudflareArtifactsError);
    });

    it("reuses a caller-supplied token without minting a new one", async () => {
      mock.on("GET", "/repos/:name", () => ({
        status: 200,
        envelope: envelope({
          id: "r1",
          name: "alice",
          description: null,
          default_branch: "main",
          created_at: "",
          updated_at: "",
          last_push_at: null,
          source: null,
          read_only: false,
          remote: "https://acct.artifacts.cloudflare.net/git/agentfs-test/alice.git",
        }),
      }));

      const { token } = await cf.createBackend("alice", {
        cacheDir: "/tmp/cache",
        token: "caller-supplied",
      });
      expect(token).toBe("caller-supplied");
      // Only the GET happened — no POST /tokens
      expect(mock.recorded).toHaveLength(1);
      expect(mock.recorded[0].method).toBe("GET");
    });
  });

  describe("error handling", () => {
    it("wraps non-success envelopes in CloudflareArtifactsError", async () => {
      mock.on("POST", "/repos", () => ({
        status: 409,
        envelope: errorEnvelope(409, "Repo already exists"),
      }));
      try {
        await cf.createRepo("alice");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(CloudflareArtifactsError);
        const err = e as CloudflareArtifactsError;
        expect(err.status).toBe(409);
        expect(err.message).toContain("already exists");
        expect(err.errors).toHaveLength(1);
        expect(err.errors[0].code).toBe(409);
      }
    });

    it("handles non-JSON responses (e.g. HTML 5xx)", async () => {
      const cf2 = new CloudflareArtifacts({
        apiToken: "t",
        namespace: "n",
        fetch: (async () => new Response("<html>500 error</html>", { status: 500 })) as any,
      });
      try {
        await cf2.getRepo("alice");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(CloudflareArtifactsError);
        expect((e as CloudflareArtifactsError).status).toBe(500);
      }
    });
  });

  describe("authentication header", () => {
    it("every call includes Bearer <apiToken>", async () => {
      mock.on("GET", "/repos/:name", () => ({
        status: 200,
        envelope: envelope({
          id: "r1",
          name: "alice",
          description: null,
          default_branch: "main",
          created_at: "",
          updated_at: "",
          last_push_at: null,
          source: null,
          read_only: false,
          remote: "https://x.cloudflare.net/git/n/alice.git",
        }),
      }));
      await cf.getRepo("alice");
      expect((mock.recorded[0].headers as any)["Authorization"]).toBe("Bearer test-api-token");
    });
  });
});
