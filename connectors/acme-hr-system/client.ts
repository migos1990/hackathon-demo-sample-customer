/**
 * HTTP client for the Acme HR System REST API.
 *
 * Uses Node 20+ native fetch. No external HTTP library.
 *
 * Contract:
 *   - 2xx        → typed response body
 *   - 404        → `null` on get / patch (caller maps to SCIM 404)
 *   - 409        → `AcmeHrSystemApiError` with status 409; caller maps to
 *                  SCIM 409 + scimType:uniqueness (RFC 7644 §3.12,
 *                  okta-dialect.md §8)
 *   - other non-2xx → `AcmeHrSystemApiError` with status + body
 *
 * 404-as-null mirrors the AcmeHR reference connector pattern
 * (connectors/acme-hr/client.ts) and keeps the UserStore interface clean —
 * store.get() / store.patch() return null for "not found".
 *
 * Authentication: Bearer token from ACME_HR_API_TOKEN env var (OKT-10).
 * Per okta-dialect.md §9: auth is required on every request to the target.
 *
 * Base URLs per environment (OKT-10):
 *   dev:     https://dev.acme-hr.example.com
 *   staging: https://staging.acme-hr.example.com
 *   prod:    https://api.acme-hr.example.com
 *
 * The active base URL is injected at construction time from the ACME_HR_BASE_URL
 * env var (defaulting to prod if unset).
 */
import type {
  AcmeHrSystemUser,
  AcmeHrSystemUserCreate,
  AcmeHrSystemUserPatch,
} from "./types.js";

export interface AcmeHrSystemClient {
  /** List all users. Used for in-memory filter (no server-side filter API). */
  listUsers(): Promise<AcmeHrSystemUser[]>;
  /** Get a single user by uid. Returns null on 404. */
  getUser(uid: string): Promise<AcmeHrSystemUser | null>;
  /** Create a new user. Throws AcmeHrSystemApiError(409) on uid collision. */
  createUser(input: AcmeHrSystemUserCreate): Promise<AcmeHrSystemUser>;
  /**
   * Partially update a user. Returns null on 404.
   * Used for both SCIM PATCH updates and soft-delete (enabled=false).
   *
   * Lifecycle policy = soft_delete (OKT-10): callers MUST NOT call deleteUser
   * for lifecycle deactivation — set enabled:false via this method instead.
   * See okta-dialect.md §3.
   */
  patchUser(
    uid: string,
    patch: AcmeHrSystemUserPatch,
  ): Promise<AcmeHrSystemUser | null>;
  /**
   * Hard-delete a user record.
   *
   * NOTE: under the soft_delete lifecycle policy (OKT-10), the SCIM
   * DELETE /Users/:id handler does NOT call this method. Instead it calls
   * patchUser with {enabled: false}. This method exists for admin-initiated
   * forced removals only — it is NOT part of the normal Okta deprovision flow.
   * See okta-dialect.md §3 ("Okta does NOT use DELETE /Users/{id} at all
   * in the standard lifecycle").
   */
  deleteUser(uid: string): Promise<void>;
}

export interface HttpAcmeHrSystemClientOptions {
  baseUrl: string;
  /** Bearer token presented to the target. Omit for dev-mode (no auth). */
  apiToken?: string;
  /** Override for tests; defaults to the ambient global `fetch` in Node 20+. */
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

  async deleteUser(uid: string): Promise<void> {
    const res = await this.request("DELETE", `/users/${encodeURIComponent(uid)}`);
    if (res.status === 404 || res.status === 204 || res.ok) return;
    throw await toApiError(res);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
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

async function toApiError(res: Response): Promise<AcmeHrSystemApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body — ignore, keep body as null.
  }
  return new AcmeHrSystemApiError(
    res.status,
    body,
    `Acme HR System API ${res.status}: ${JSON.stringify(body)}`,
  );
}