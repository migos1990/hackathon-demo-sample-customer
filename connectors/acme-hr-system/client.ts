/**
 * HTTP client for Acme HR System native API.
 *
 * Targets: https://api.acme-hr.example.com (prod)
 *          https://staging.acme-hr.example.com (staging)
 *          https://dev.acme-hr.example.com (dev)
 *
 * Auth: Bearer token from ACME_HR_API_TOKEN env var (ticket OKT-10
 * auth_method: bearer, auth_credential_env_var: ACME_HR_API_TOKEN).
 *
 * HTTP client contract (mirrors connectors/acme-hr/client.ts convention):
 *   - 2xx       → typed response body
 *   - 404       → null on get/patch (callers check null for not-found)
 *   - 409       → AcmeHrSystemApiError(409) — caller maps to SCIM uniqueness
 *   - other non-2xx → AcmeHrSystemApiError with status + body
 *
 * Uses Node 20+ native fetch. No external HTTP library.
 *
 * Rate limiting: the server emits 429 with Retry-After when needed.
 * Callers (store.ts) propagate this as-is; Okta's client respects
 * Retry-After per okta-dialect.md §9.
 */
import type {
  AcmeHrSystemUser,
  AcmeHrSystemUserCreate,
  AcmeHrSystemUserPatch,
} from "./types.js";

// ─── Errors ───────────────────────────────────────────────────────────────────

export class AcmeHrSystemApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `Acme HR System API error (HTTP ${status})`);
    this.name = "AcmeHrSystemApiError";
  }
}

// ─── Interface ────────────────────────────────────────────────────────────────

export interface AcmeHrSystemClient {
  /** List all users (no server-side filter — connector filters in-memory). */
  listUsers(): Promise<AcmeHrSystemUser[]>;
  /** Get a single user by uid. Returns null on 404. */
  getUser(uid: string): Promise<AcmeHrSystemUser | null>;
  /** Create a new user. Throws AcmeHrSystemApiError(409) on uid conflict. */
  createUser(input: AcmeHrSystemUserCreate): Promise<AcmeHrSystemUser>;
  /**
   * Partial-update a user. Returns null on 404 (not found).
   *
   * Soft-delete is implemented here: PATCH {enabled: false} retains the row.
   * The API must NOT hard-delete on any PATCH path — soft_delete policy
   * (ticket OKT-10) requires row retention for audit (okta-dialect.md §3).
   */
  patchUser(uid: string, patch: AcmeHrSystemUserPatch): Promise<AcmeHrSystemUser | null>;
  /**
   * Soft-delete by uid — maps to PATCH {enabled: false} on the native API.
   *
   * Soft-delete policy (ticket OKT-10 lifecycle_policy: soft_delete,
   * okta-dialect.md §3): rows are never physically removed. DELETE on the
   * SCIM side converges on the same end-state as PATCH active: false.
   * Returns null on 404.
   */
  deactivateUser(uid: string): Promise<AcmeHrSystemUser | null>;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export interface HttpAcmeHrSystemClientOptions {
  baseUrl: string;
  /** Bearer token for the native API. Omit for dev/test (no auth). */
  apiToken?: string;
  /** Override fetch for unit tests — defaults to global fetch (Node 20+). */
  fetchImpl?: typeof fetch;
}

export class HttpAcmeHrSystemClient implements AcmeHrSystemClient {
  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpAcmeHrSystemClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    if (opts.apiToken !== undefined) this.apiToken = opts.apiToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async listUsers(): Promise<AcmeHrSystemUser[]> {
    const res = await this.request("GET", "/users");
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeHrSystemUser[];
  }

  async getUser(uid: string): Promise<AcmeHrSystemUser | null> {
    const res = await this.request("GET", `/users/${encodeURIComponent(uid)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeHrSystemUser;
  }

  async createUser(input: AcmeHrSystemUserCreate): Promise<AcmeHrSystemUser> {
    const res = await this.request("POST", "/users", input);
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeHrSystemUser;
  }

  async patchUser(
    uid: string,
    patch: AcmeHrSystemUserPatch,
  ): Promise<AcmeHrSystemUser | null> {
    const res = await this.request(
      "PATCH",
      `/users/${encodeURIComponent(uid)}`,
      patch,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeHrSystemUser;
  }

  async deactivateUser(uid: string): Promise<AcmeHrSystemUser | null> {
    // Soft-delete is a PATCH {enabled: false} — row is retained.
    // okta-dialect.md §3: DELETE on the SCIM side must converge on the same
    // end-state as PATCH active: false for soft_delete policy.
    return this.patchUser(uid, { enabled: false });
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.apiToken !== undefined) {
      headers["authorization"] = `Bearer ${this.apiToken}`;
    }

    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }
}

// ─── Error factory ────────────────────────────────────────────────────────────

async function toApiError(res: Response): Promise<AcmeHrSystemApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body — leave body as null.
  }
  return new AcmeHrSystemApiError(
    res.status,
    body,
    `Acme HR System API ${res.status}: ${JSON.stringify(body)}`,
  );
}