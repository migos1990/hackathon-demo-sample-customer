/**
 * HTTP client for the Acme HR System native API.
 *
 * Uses Node 20+ native fetch. No external HTTP library.
 *
 * Contract (mirrors connectors/acme-hr/client.ts pattern):
 *   - 2xx       → typed response body
 *   - 404       → null on get / patch / delete (caller maps to SCIM 404)
 *   - 409       → AcmeHrSystemApiError(409) — caller maps to SCIM
 *                 409 + scimType:"uniqueness" per RFC 7644 §3.12
 *                 and okta-dialect.md §8
 *   - other non-2xx → AcmeHrSystemApiError with status + body
 *
 * Lifecycle_policy=soft_delete (OKT-10): there is no hard-delete endpoint
 * called from this connector. The `deleteUser` method issues a PATCH that
 * sets enabled:false on the target, matching the semantics described in
 * okta-dialect.md §3 "Soft delete / deactivate (default)".
 *
 * Environments (OKT-10):
 *   dev:     https://dev.acme-hr.example.com
 *   staging: https://staging.acme-hr.example.com
 *   prod:    https://api.acme-hr.example.com
 * Select via ACME_HR_SYSTEM_BASE_URL env var; see RUNBOOK.md.
 *
 * Authentication: Bearer token from ACME_HR_API_TOKEN env var per
 * okta-dialect.md §9 and ticket auth_method=bearer.
 *
 * Ticket: OKT-10
 */
import type {
  AcmeHrSystemUser,
  AcmeHrSystemUserCreate,
  AcmeHrSystemUserPatch,
} from "./types.js";

export interface AcmeHrSystemClient {
  /** Cheap reachability probe — used by /healthz. */
  ping(): Promise<void>;
  listUsers(): Promise<AcmeHrSystemUser[]>;
  getUser(uid: string): Promise<AcmeHrSystemUser | null>;
  createUser(input: AcmeHrSystemUserCreate): Promise<AcmeHrSystemUser>;
  patchUser(
    uid: string,
    patch: AcmeHrSystemUserPatch,
  ): Promise<AcmeHrSystemUser | null>;
  /**
   * Soft-delete: sets enabled:false on the target user.
   * Returns null when the user does not exist (caller maps to 404).
   * Per lifecycle_policy=soft_delete — no hard-delete is ever issued.
   * okta-dialect.md §3.
   */
  softDeleteUser(uid: string): Promise<AcmeHrSystemUser | null>;
}

export interface HttpAcmeHrSystemClientOptions {
  baseUrl: string;
  apiToken?: string;
  /** Override for unit tests; defaults to Node 20+ ambient `fetch`. */
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
    // Strip trailing slashes so path concatenation is stable.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    if (opts.apiToken !== undefined) this.apiToken = opts.apiToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async ping(): Promise<void> {
    // HEAD /users — minimal round-trip to confirm API reachability.
    // Falls back to GET /users if the target doesn't support HEAD.
    const res = await this.request("HEAD", "/users");
    if (!res.ok && res.status !== 405) {
      // 405 Method Not Allowed on HEAD → try GET as fallback.
      const getRes = await this.request("GET", "/users");
      if (!getRes.ok) throw await toApiError(getRes);
    }
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
   * Soft-delete implementation: PATCH enabled=false.
   *
   * lifecycle_policy=soft_delete means Okta's DELETE /Users/:id signal is
   * translated into a deactivation, not a row removal. The native API
   * retains the user row (7-year retention implied by soft-delete policy).
   * Per okta-dialect.md §3 "Soft delete / deactivate (default)".
   */
  async softDeleteUser(uid: string): Promise<AcmeHrSystemUser | null> {
    return this.patchUser(uid, { enabled: false });
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      // Outbound requests to the native API use application/json, not
      // application/scim+json — the target is not a SCIM server.
      ...(body !== undefined && { "content-type": "application/json" }),
      // Bearer auth per okta-dialect.md §9 and ticket auth_method=bearer.
      ...(this.apiToken !== undefined && {
        authorization: `Bearer ${this.apiToken}`,
      }),
    };

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
    // Non-JSON body — leave body null.
  }
  return new AcmeHrSystemApiError(
    res.status,
    body,
    `Acme HR System API ${res.status}: ${JSON.stringify(body)}`,
  );
}