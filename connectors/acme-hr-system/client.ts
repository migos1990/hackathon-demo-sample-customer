/**
 * HTTP client for Acme HR System's native API.
 *
 * Uses Node 20+ native fetch — no external HTTP library.
 * Auth: Bearer token from ACME_HR_API_TOKEN env var per OKT-10
 * `auth_credential_env_var`.
 *
 * Contract (mirrors connectors/acme-hr/client.ts convention):
 *   - 2xx   → typed response body
 *   - 404   → null on get/patch (store layer converts to SCIM 404)
 *   - non-2xx → AcmeHrSystemApiError with status + body; caller dispatches
 *
 * Soft-delete policy (OKT-10 lifecycle_policy: soft_delete):
 * There is no DELETE on the native API — deactivation is achieved by
 * PATCH { enabled: false }. The `deactivateUser` method makes this
 * explicit. docs/okta-dialect.md §3 "policy-consistent DELETE and
 * PATCH-active-false handlers".
 *
 * Environment-aware base URL: read from ACME_HR_BASE_URL at runtime.
 * Per OKT-10 environments map:
 *   dev     → https://dev.acme-hr.example.com
 *   staging → https://staging.acme-hr.example.com
 *   prod    → https://api.acme-hr.example.com  (default)
 * Set ACME_HR_BASE_URL in the deployment environment; the factory reads it.
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
  /** Cheap liveness probe — used by /healthz. Docs: okta-dialect.md §9 / Law 8. */
  listUsers(): Promise<AcmeHrSystemUser[]>;
  getUser(uid: string): Promise<AcmeHrSystemUser | null>;
  createUser(input: AcmeHrSystemUserCreate): Promise<AcmeHrSystemUser>;
  patchUser(
    uid: string,
    patch: AcmeHrSystemUserPatch,
  ): Promise<AcmeHrSystemUser | null>;
  /**
   * Convenience wrapper for the soft-delete path. Equivalent to
   * patchUser(uid, { enabled: false }) — exists so the store's DELETE
   * handler reads semantically rather than passing a magic object literal.
   * docs/okta-dialect.md §3: "DELETE handler and PATCH-active-false handler
   * MUST be policy-consistent."
   */
  deactivateUser(uid: string): Promise<AcmeHrSystemUser | null>;
}

export interface HttpAcmeHrSystemClientOptions {
  /** Target API base URL. Trailing slashes are stripped. */
  baseUrl: string;
  /** Bearer token presented to the target API. Omit for dev-mode. */
  apiToken?: string;
  /**
   * Override fetch implementation for unit tests (avoid real network).
   * Defaults to the ambient global `fetch` (Node 20+).
   */
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
    super(message ?? `Acme HR System API error (status ${status})`);
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
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
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
   * Soft-delete by setting enabled=false. Never issues a DELETE on the wire.
   * docs/okta-dialect.md §3 soft_delete policy.
   */
  async deactivateUser(uid: string): Promise<AcmeHrSystemUser | null> {
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
      accept: "application/json",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.apiToken !== undefined) {
      // docs/okta-dialect.md §9 — bearer token auth.
      // Credential sourced from ACME_HR_API_TOKEN env var (OKT-10
      // auth_credential_env_var). NEVER hard-coded per Connector Law 4
      // (SECRETS-OUT).
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
// Helper
// ---------------------------------------------------------------------------

async function toApiError(res: Response): Promise<AcmeHrSystemApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body — leave body as null; status + URL in message is enough.
  }
  return new AcmeHrSystemApiError(
    res.status,
    body,
    `Acme HR System API ${res.status}: ${JSON.stringify(body)}`,
  );
}