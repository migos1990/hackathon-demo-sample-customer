/**
 * HTTP client for the Acme HR System target API.
 *
 * Ticket: OKT-10  base_url: https://api.acme-hr.example.com
 *                 auth_method: bearer  auth_credential_env: ACME_HR_API_TOKEN
 *
 * Uses Node 20+ native fetch. No external HTTP lib.
 *
 * Contract:
 *   - 2xx       → typed response body
 *   - 404       → null on get / patch (see note below)
 *   - non-2xx   → AcmeHrSystemApiError, caller dispatches
 *
 * 404-as-null is intentional: the UserStore interface (skeleton/store/
 * user-store.ts) returns null for "not found". Translating here keeps the
 * store layer free of HTTP semantics.
 *
 * Error mapping:
 *   - 409 on createUser → caller translates to UserNameConflictError →
 *     SCIM 409 + scimType:"uniqueness" per RFC 7644 §3.12 and
 *     okta-dialect.md §8.
 *
 * Rate limiting:
 *   - okta-dialect.md §9: Okta respects Retry-After on 429. This client
 *     propagates AcmeHrSystemApiError(429) upward; the skeleton's route
 *     layer converts that to a 429 + Retry-After response to Okta.
 *     (The connector itself does NOT retry — retrying inside the SCIM
 *     server would hide problems and extend latency; let Okta drive
 *     retry with exponential backoff.)
 *
 * Endpoint assumptions (from ticket fields / LDAP pattern):
 *   GET    /users            → AcmeHrSystemUser[]
 *   GET    /users/:uid       → AcmeHrSystemUser | 404
 *   POST   /users            → AcmeHrSystemUser (201) | 409 (uid conflict)
 *   PATCH  /users/:uid       → AcmeHrSystemUser | 404
 *   DELETE /users/:uid       → 204 | 404
 *     Note: required_ops.users_delete=true in OKT-10 but lifecycle_policy=
 *     soft_delete means the SCIM DELETE handler flips enabled=false via
 *     PATCH rather than calling this DELETE endpoint. DELETE here is kept
 *     for completeness / admin tooling. See store.ts for the policy logic.
 */

import type {
  AcmeHrSystemUser,
  AcmeHrSystemUserCreate,
  AcmeHrSystemUserPatch,
} from "./types.js";

export interface AcmeHrSystemClient {
  listUsers(): Promise<AcmeHrSystemUser[]>;
  getUser(uid: string): Promise<AcmeHrSystemUser | null>;
  createUser(input: AcmeHrSystemUserCreate): Promise<AcmeHrSystemUser>;
  patchUser(
    uid: string,
    patch: AcmeHrSystemUserPatch,
  ): Promise<AcmeHrSystemUser | null>;
  deleteUser(uid: string): Promise<boolean>;
}

export interface HttpAcmeHrSystemClientOptions {
  baseUrl: string;
  apiToken?: string;
  /** Override for tests; defaults to the ambient global fetch in Node 20+. */
  fetchImpl?: typeof fetch;
}

export class AcmeHrSystemApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `Acme HR System API error (status ${status})`);
    this.name = "AcmeHrSystemApiError";
  }
}

export class HttpAcmeHrSystemClient implements AcmeHrSystemClient {
  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpAcmeHrSystemClientOptions) {
    // Strip trailing slashes so path concatenation is always clean.
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
    const res = await this.request(
      "GET",
      `/users/${encodeURIComponent(uid)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeHrSystemUser;
  }

  async createUser(
    input: AcmeHrSystemUserCreate,
  ): Promise<AcmeHrSystemUser> {
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

  /**
   * Hard-delete a user row. Called ONLY by admin tooling / forced-removal
   * path — NOT by the SCIM DELETE handler (which uses soft-delete via PATCH
   * per lifecycle_policy=soft_delete). okta-dialect.md §3.
   * Returns true on 204, false on 404 (already gone).
   */
  async deleteUser(uid: string): Promise<boolean> {
    const res = await this.request(
      "DELETE",
      `/users/${encodeURIComponent(uid)}`,
    );
    if (res.status === 204 || res.status === 200) return true;
    if (res.status === 404) return false;
    throw await toApiError(res);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.apiToken !== undefined)
      headers["authorization"] = `Bearer ${this.apiToken}`;

    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }
}

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