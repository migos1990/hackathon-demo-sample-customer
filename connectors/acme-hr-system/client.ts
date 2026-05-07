/**
 * HTTP client for the Acme HR System API (LDAP-shaped REST).
 *
 * Uses Node 20+ native fetch — no external HTTP library dependency.
 *
 * Contract:
 *   2xx       → typed response body
 *   404 on GET/PATCH → `null` (documented interface; store maps to SCIM 404)
 *   409 on POST      → `AcmeHrSystemApiError(409)` (store maps to SCIM uniqueness)
 *   any other non-2xx → `AcmeHrSystemApiError` (store re-throws; skeleton 500s)
 *
 * 404-as-null is intentional. The UserStore interface (skeleton/store/
 * user-store.ts) returns `null` for "not found", keeping HTTP semantics
 * out of the store layer. See connectors/acme-hr/client.ts for the same
 * rationale in the reference connector.
 *
 * Authentication: Bearer token from ACME_HR_API_TOKEN env var.
 * Per ticket auth_method=bearer, auth_credential_env_var=ACME_HR_API_TOKEN.
 * okta-dialect.md §9.
 */

import type {
  AcmeHrSystemUser,
  AcmeHrSystemUserCreate,
  AcmeHrSystemUserPatch,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface AcmeHrSystemClient {
  /** List all users. Used for in-memory filter + health probe. */
  listUsers(): Promise<AcmeHrSystemUser[]>;
  /** Get a single user by uid. Returns null on 404. */
  getUser(uid: string): Promise<AcmeHrSystemUser | null>;
  /** Create a user. Throws AcmeHrSystemApiError(409) on uid collision. */
  createUser(input: AcmeHrSystemUserCreate): Promise<AcmeHrSystemUser>;
  /**
   * Partial-update a user. Returns null on 404 (user does not exist).
   * Soft-delete (enabled=false) flows through here — no separate delete
   * endpoint is called. Ticket lifecycle_policy=soft_delete.
   * okta-dialect.md §3.
   */
  patchUser(
    uid: string,
    patch: AcmeHrSystemUserPatch,
  ): Promise<AcmeHrSystemUser | null>;
  /**
   * Hard-delete endpoint wrapper — included because ticket
   * required_ops.users_delete=true. Implementations that hit a real
   * DELETE endpoint should use this. The store layer enforces the
   * soft-delete policy by NEVER calling this; it calls patchUser with
   * {enabled:false} instead. This method exists so the client type is
   * complete and testable.
   *
   * Returns true on 204, false on 404. Throws on other errors.
   */
  deleteUser(uid: string): Promise<boolean>;
}

export interface HttpAcmeHrSystemClientOptions {
  /** Base URL of the Acme HR System API — no trailing slash. */
  baseUrl: string;
  /** Bearer token for the Acme HR System API. Omit for dev-mode (no auth). */
  apiToken?: string;
  /** Override the fetch implementation. Defaults to global fetch (Node 20+). */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class HttpAcmeHrSystemClient implements AcmeHrSystemClient {
  private readonly baseUrl: string;
  private readonly apiToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpAcmeHrSystemClientOptions) {
    // Strip trailing slash for safe path concatenation.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiToken = opts.apiToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async listUsers(): Promise<AcmeHrSystemUser[]> {
    const res = await this.request("GET", "/users");
    if (!res.ok) throw await buildApiError(res);
    return (await res.json()) as AcmeHrSystemUser[];
  }

  async getUser(uid: string): Promise<AcmeHrSystemUser | null> {
    const res = await this.request("GET", `/users/${encodeURIComponent(uid)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await buildApiError(res);
    return (await res.json()) as AcmeHrSystemUser;
  }

  async createUser(input: AcmeHrSystemUserCreate): Promise<AcmeHrSystemUser> {
    const res = await this.request("POST", "/users", input);
    if (!res.ok) throw await buildApiError(res);
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
    if (!res.ok) throw await buildApiError(res);
    return (await res.json()) as AcmeHrSystemUser;
  }

  async deleteUser(uid: string): Promise<boolean> {
    const res = await this.request(
      "DELETE",
      `/users/${encodeURIComponent(uid)}`,
    );
    if (res.status === 204 || res.status === 200) return true;
    if (res.status === 404) return false;
    throw await buildApiError(res);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (this.apiToken !== undefined) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }

    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }
}

async function buildApiError(res: Response): Promise<AcmeHrSystemApiError> {
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