/**
 * Cloudflare Artifacts integration.
 *
 * Artifacts is Cloudflare's Git-compatible artifact store. The data
 * plane is standard smart-HTTPS Git — just-stash's `GitBackend` talks
 * to it without modification. The management plane (create repos,
 * server-side fork, mint tokens) is a REST API. This module covers
 * the management plane and returns pre-configured `GitBackend`
 * instances ready for the data plane.
 *
 * Usage:
 *
 *   const cf = new CloudflareArtifacts({
 *     apiToken: process.env.CF_API_TOKEN!,
 *     namespace: 'my-agents',
 *   });
 *
 *   // For each sandbox: ensure repo exists, mint a token, build backend
 *   const { backend, repo } = await cf.createBackend('alice', {
 *     cacheDir: '/var/lib/just-stash/caches/alice.git',
 *   });
 *
 *   // Server-side fork (no data transfer; one HTTP call)
 *   const fork = await cf.forkRepo('alice', { name: 'alice-experiment' });
 *
 *   // Cleanup when done
 *   await cf.deleteRepo('alice-experiment');
 *
 * Slots into WorkspaceManager via backendFactory:
 *
 *   const manager = new WorkspaceManager({
 *     root: '/var/lib/just-stash',
 *     defaults: {
 *       backendFactory: async (sandboxId) =>
 *         (await cf.createBackend(sandboxId, {
 *           cacheDir: `/var/lib/just-stash/caches/${sandboxId}.git`,
 *         })).backend,
 *     },
 *   });
 *
 * The REST surface mirrors Cloudflare's API:
 *   https://developers.cloudflare.com/artifacts/api/rest-api/
 */

import http from "isomorphic-git/http/node";
import { GitBackend, type GitBackendOptions } from "./backends/git.ts";

// ---------------------------------------------------------------------------
// API types — mirror Cloudflare's documented response shapes
// ---------------------------------------------------------------------------

export interface RepoInfo {
  id: string;
  name: string;
  description: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  last_push_at: string | null;
  source: string | null;
  read_only: boolean;
}

export interface RemoteRepoInfo extends RepoInfo {
  remote: string;
}

export interface RepoWithToken extends RemoteRepoInfo {
  token: string;
  expires_at: string;
}

export interface TokenInfo {
  id: string;
  scope: "read" | "write";
  state: "active" | "expired" | "revoked";
  created_at: string;
  expires_at: string;
}

export interface TokenWithSecret {
  id: string;
  plaintext: string;
  scope: "read" | "write";
  expires_at: string;
}

export interface ApiErrorDetail {
  code: number;
  message: string;
  documentation_url?: string;
  source?: { pointer?: string };
}

/**
 * Thrown when the Artifacts REST API returns a non-success envelope
 * or an HTTP error.
 */
export class CloudflareArtifactsError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errors: ApiErrorDetail[] = [],
  ) {
    super(message);
    this.name = "CloudflareArtifactsError";
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface CloudflareArtifactsOptions {
  /** Cloudflare API token with Artifacts permissions. */
  apiToken: string;
  /** Namespace name. Defaults to 'default'. */
  namespace?: string;
  /**
   * Base URL override. Default is the public Artifacts endpoint.
   * Useful for testing against a mock or staging deployment.
   */
  baseUrl?: string;
  /**
   * Inject a custom fetch implementation. Defaults to global fetch.
   * Mainly for testing.
   */
  fetch?: typeof globalThis.fetch;
}

export interface CreateRepoOptions {
  description?: string;
  default_branch?: string;
  read_only?: boolean;
}

export interface ForkRepoOptions {
  name: string;
  description?: string;
  read_only?: boolean;
  /** If true, only the default branch is forked. Smaller, faster. */
  default_branch_only?: boolean;
}

export interface ImportRepoOptions {
  /** Public HTTPS git URL to import from. */
  url: string;
  /** Branch to import. Default: source repo's default branch. */
  branch?: string;
  /** Shallow-clone depth. Omit for full history. */
  depth?: number;
  read_only?: boolean;
}

export interface CreateTokenOptions {
  /** Default: 'write'. */
  scope?: "read" | "write";
  /** TTL in seconds. Default: 86400 (24h). */
  ttl?: number;
}

export interface CreateBackendOptions {
  /** Local cache directory. Required for GitBackend. */
  cacheDir: string;
  /** Pre-existing repo token to reuse instead of minting a fresh one. */
  token?: string;
  /** Branch ref. Defaults to the repo's `default_branch`. */
  branch?: string;
  /**
   * If true, ensure the repo exists (create if missing). If false,
   * fail when the repo doesn't exist. Default: true.
   */
  ensureRepo?: boolean;
  /**
   * Pass-through to `GitBackend` constructor. Useful for custom
   * commit author defaults, etc.
   */
  gitBackendOptions?: Omit<GitBackendOptions, "cacheDir" | "remote" | "branch">;
}

export interface CreateBackendResult {
  backend: GitBackend;
  repo: RemoteRepoInfo;
  /**
   * The token used to construct this backend. Useful if the caller
   * wants to track expiry. Note: tokens are secrets — don't log them.
   */
  token: string;
  /** When this token expires (ISO 8601 timestamp). */
  expiresAt: string;
}

export class CloudflareArtifacts {
  private readonly apiToken: string;
  private readonly namespace: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: CloudflareArtifactsOptions) {
    this.apiToken = opts.apiToken;
    this.namespace = opts.namespace ?? "default";
    this.baseUrl =
      opts.baseUrl ?? `https://artifacts.cloudflare.net/v1/api/namespaces/${this.namespace}`;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  // ---------- Repos ----------

  async createRepo(name: string, opts: CreateRepoOptions = {}): Promise<RepoWithToken> {
    return this.call<RepoWithToken>("POST", "/repos", {
      name,
      ...opts,
    });
  }

  async getRepo(name: string): Promise<RemoteRepoInfo> {
    return this.call<RemoteRepoInfo>("GET", `/repos/${encodeURIComponent(name)}`);
  }

  async listRepos(opts?: {
    limit?: number;
    cursor?: string;
    search?: string;
    sort?: "created_at" | "updated_at" | "last_push_at" | "name";
    direction?: "asc" | "desc";
  }): Promise<RepoInfo[]> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.search) params.set("search", opts.search);
    if (opts?.sort) params.set("sort", opts.sort);
    if (opts?.direction) params.set("direction", opts.direction);
    const qs = params.toString();
    return this.call<RepoInfo[]>("GET", `/repos${qs ? `?${qs}` : ""}`);
  }

  async deleteRepo(name: string): Promise<void> {
    await this.call<{ id: string }>("DELETE", `/repos/${encodeURIComponent(name)}`);
  }

  /**
   * Server-side fork. Returns the new repo with a fresh token.
   * No data transfer — Artifacts handles the copy server-side.
   */
  async forkRepo(
    sourceName: string,
    opts: ForkRepoOptions,
  ): Promise<RepoWithToken & { objects: number }> {
    return this.call<RepoWithToken & { objects: number }>(
      "POST",
      `/repos/${encodeURIComponent(sourceName)}/fork`,
      opts,
    );
  }

  /**
   * Import a public HTTPS git remote (e.g. github.com/...) into a new
   * Artifacts repo. Useful for seeding a sandbox from a known starting
   * codebase.
   */
  async importRepo(name: string, opts: ImportRepoOptions): Promise<RepoWithToken> {
    return this.call<RepoWithToken>("POST", `/repos/${encodeURIComponent(name)}/import`, opts);
  }

  // ---------- Tokens ----------

  async createToken(repo: string, opts: CreateTokenOptions = {}): Promise<TokenWithSecret> {
    return this.call<TokenWithSecret>("POST", "/tokens", { repo, ...opts });
  }

  async listTokens(
    repo: string,
    opts?: {
      state?: "active" | "expired" | "revoked" | "all";
      per_page?: number;
      page?: number;
    },
  ): Promise<TokenInfo[]> {
    const params = new URLSearchParams();
    if (opts?.state) params.set("state", opts.state);
    if (opts?.per_page !== undefined) params.set("per_page", String(opts.per_page));
    if (opts?.page !== undefined) params.set("page", String(opts.page));
    const qs = params.toString();
    return this.call<TokenInfo[]>(
      "GET",
      `/repos/${encodeURIComponent(repo)}/tokens${qs ? `?${qs}` : ""}`,
    );
  }

  async revokeToken(tokenId: string): Promise<void> {
    await this.call<{ id: string }>("DELETE", `/tokens/${encodeURIComponent(tokenId)}`);
  }

  // ---------- High-level convenience ----------

  /**
   * Build a `GitBackend` pre-configured to talk to a specific repo.
   *
   * If the repo doesn't exist (and `ensureRepo` isn't false), creates
   * it. Mints a fresh token unless one is supplied. Returns the
   * backend along with the repo info and the token that was used —
   * caller can track expiry and re-acquire when needed.
   *
   *   const { backend, expiresAt } = await cf.createBackend('alice', {
   *     cacheDir: '/var/lib/just-stash/caches/alice.git',
   *   });
   *   // ... use backend ...
   *   // When token nears expiry, call createBackend again or mint a
   *   // fresh token with createToken().
   */
  async createBackend(repoName: string, opts: CreateBackendOptions): Promise<CreateBackendResult> {
    let repo: RemoteRepoInfo;
    let token = opts.token;
    let expiresAt: string;

    if (token) {
      // Caller-supplied token: just look up the repo
      repo = await this.getRepo(repoName);
      // We don't know when this token expires; caller is responsible
      expiresAt = "unknown";
    } else {
      // Need to mint a token. First check if the repo exists.
      let existing: RemoteRepoInfo | null = null;
      try {
        existing = await this.getRepo(repoName);
      } catch (e) {
        if (!(e instanceof CloudflareArtifactsError) || e.status !== 404) throw e;
      }

      if (existing) {
        repo = existing;
        const t = await this.createToken(repoName, { scope: "write" });
        token = t.plaintext;
        expiresAt = t.expires_at;
      } else if (opts.ensureRepo !== false) {
        // Repo doesn't exist; create it. The creation response includes
        // a fresh token, so no separate token call needed.
        const created = await this.createRepo(repoName);
        const { token: createdToken, expires_at, ...repoInfo } = created;
        repo = repoInfo;
        token = createdToken;
        expiresAt = expires_at;
      } else {
        throw new CloudflareArtifactsError(
          `Repo "${repoName}" not found and ensureRepo: false`,
          404,
        );
      }
    }

    const backend = new GitBackend({
      cacheDir: opts.cacheDir,
      branch: opts.branch ?? repo.default_branch,
      remote: {
        url: repo.remote,
        // Artifacts ignores the username; password slot carries the token
        username: "x",
        token,
        http,
      },
      ...opts.gitBackendOptions,
    });

    return { backend, repo, token, expiresAt };
  }

  // ---------- Internal ----------

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    const res = await this.fetchImpl(url, init);
    const text = await res.text();
    let envelope: { result: T | null; success: boolean; errors: ApiErrorDetail[] };
    try {
      envelope = JSON.parse(text);
    } catch {
      // Non-JSON response (rare; usually means 5xx HTML)
      throw new CloudflareArtifactsError(
        `Artifacts API ${method} ${path} returned ${res.status}: ${text.slice(0, 200)}`,
        res.status,
      );
    }

    if (!res.ok || !envelope.success) {
      const firstError = envelope.errors?.[0];
      const message = firstError?.message ?? `Artifacts API ${method} ${path} failed`;
      throw new CloudflareArtifactsError(
        `${message} (HTTP ${res.status})`,
        res.status,
        envelope.errors ?? [],
      );
    }

    if (envelope.result === null) {
      throw new CloudflareArtifactsError(
        `Artifacts API ${method} ${path} returned null result`,
        res.status,
      );
    }

    return envelope.result;
  }
}
