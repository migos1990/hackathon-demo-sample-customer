/**
 * HTTP client for the Acme HR System native API.
 *
 * ticket: OKT-10
 * customer: Acme HR System
 * slug: acme-hr-system
 *
 * Design decisions:
 *   - Uses Node 20+ native fetch (no external HTTP lib).
 *   - 2xx          → typed response body returned to caller.
 *   - 404 on get/patch → `null` returned (store layer translates to SCIM 404).
 *   - 409 on create    → AcmeHrSystemApiError(409) thrown; store layer maps
 *                        to UserNameConflictError → SCIM 409 + uniqueness.
 *   - Other non-2xx    → AcmeHrSystemApiError thrown with status + body.
 *
 * 404-as-null contract mirrors the skeleton UserStore interface
 * (skeleton/store/user-store.ts) which returns null for "not found".
 * Keeping HTTP semantics out of the store keeps the store simple.
 *
 * Auth: Bearer token from ACME_HR_API_TOKEN env var, injected at
 * construction time per okta-dialect.md §9 and ticket OKT-10
 * auth_method:bearer / auth_credential_env_var:ACME_HR_API_TOKEN.
 *
 * Base URLs per OKT-10 environments field:
 *   dev:     https://dev.acme-hr.example.com
 *   staging: https://staging.acme-hr.example.com
 *   prod:    https://api.acme-hr.example.com
 * Injected via ACME_HR_BASE_URL env var (see RUNBOOK.md).
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
  /** List all users. Used for in-memory filter (no server-side filter API). */
  listUsers(): Promise<AcmeHrSystemUser[]>;
  /** Fetch a single user by uid. Returns null if not found (404). */
  getUser(uid: string): Promise<AcmeHrSystemUser | null>;
  /** Create a user. Throws AcmeHrSystemApiError(409) on uid conflict. */
  createUser(input: AcmeHrSystemUserCreate): Promise<AcmeHrSystemUser>;
  /**
   * Patch a user. Returns null if not found (404).
   * Used for both profile updates and soft-delete (enabled:false).
   * Per okta-dialect.md §3: soft_delete policy means we NEVER issue
   * a DELETE to the target — all lifecycle changes go through this method.
   */
  patchUser(
    uid: string,
    patch: AcmeHrSystemUserPatch,
  ): Promise<AcmeHrSystemUser | null>;
  /**
   * Soft-delete a user: sets enabled:false on the target.
   * Called by the store's delete() method which implements the
   * lifecycle_policy: soft_delete contract from OKT-10.
   * Per okta-dialect.md §3: Okta sends DELETE /Users/:id in edge cases;
   * we honour the request but implement it as a deactivation, not a row drop.
   */
  softDeleteUser(uid: string): Promise<AcmeHrSystemUser | null>;
}

export interface HttpAcmeHrSystemClientOptions {
  baseUrl: string;
  apiToken?: string;
  /** Injectable fetch for tests; defaults to Node 20+ global fetch. */
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
    super(message ?? `AcmeHrSystem API error (status ${status})`);
    this.name = "AcmeHrSystemApiError";
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

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

  /**
   * Soft-delete: PATCH the user to set enabled:false on the native API.
   * Per okta-dialect.md §3: lifecycle_policy soft_delete means the row is
   * NEVER removed from the target system; deactivation is the sole
   * lifecycle terminus. The target's audit retention is preserved.
   */
  async softDeleteUser(uid: string): Promise<AcmeHrSystemUser | null> {
    return this.patchUser(uid, { enabled: false });
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      // Accept both content types on responses per okta-dialect.md §10.
      accept: "application/json",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    // Bearer token per OKT-10 auth_method:bearer.
    // Per okta-dialect.md §9: every protected request must carry the token.
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

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

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
    `AcmeHrSystem API ${res.status}: ${JSON.stringify(body)}`,
  );
}