/**
 * HTTP client for Acme HR System's native LDAP-shaped REST API.
 *
 * Uses Node 20+ native fetch. No external HTTP libraries.
 *
 * Contract (mirrors connectors/acme-hr/client.ts pattern):
 *   - 2xx     → typed response body
 *   - 404     → null on get / patch / delete (caller maps to SCIM 404)
 *   - non-2xx → AcmeHrSystemApiError with status + body; caller dispatches
 *
 * 404-as-null is intentional: the UserStore interface returns null for
 * "not found". Keeping HTTP semantics in the client keeps store.ts simple.
 *
 * Authentication: Bearer token from ACME_HR_API_TOKEN env var.
 * Per okta-dialect.md §9 + OKT-10 ticket auth_method=bearer.
 *
 * Ticket: OKT-10
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
  /**
   * Soft-delete: sets enabled=false on the target row.
   *
   * lifecycle_policy=soft_delete means the native API never physically
   * removes a user. We achieve "delete" by patching enabled→false.
   * Returns null if the user does not exist (caller maps to 404).
   * okta-dialect.md §3 — Okta's DELETE is edge-case only; primary path
   * is PATCH active:false.
   */
  deleteUser(uid: string): Promise<AcmeHrSystemUser | null>;
}

export interface HttpAcmeHrSystemClientOptions {
  baseUrl: string;
  /** Bearer token presented to Acme HR System API. Omit in dev-mode. */
  apiToken?: string;
  /** Inject a custom fetch implementation (e.g. for tests). Defaults to global fetch. */
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
    const res = await this.request("GET", `/users/${enc(uid)}`);
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
    const res = await this.request("PATCH", `/users/${enc(uid)}`, patch);
    if (res.status === 404) return null;
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeHrSystemUser;
  }

  /**
   * Soft-delete implementation: PATCH {enabled: false}.
   *
   * Acme HR System retains rows permanently (7-year audit retention).
   * lifecycle_policy=soft_delete in OKT-10 ticket mandates this.
   * okta-dialect.md §3 "Soft vs hard delete — deprovisioning semantics":
   * soft_delete policy → DELETE handler and PATCH-active-false handler
   * MUST yield identical outcomes (both set enabled=false, retain row).
   */
  async deleteUser(uid: string): Promise<AcmeHrSystemUser | null> {
    // First confirm the user exists so we can distinguish 404 from success.
    const existing = await this.getUser(uid);
    if (existing === null) return null;
    // Already deactivated — idempotent. okta-dialect.md §4 reactivation note:
    // same logic applies in reverse; deactivating an already-deactivated user
    // is a no-op that returns 200 + current body.
    if (!existing.enabled) return existing;
    return this.patchUser(uid, { enabled: false });
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
    };
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

function enc(uid: string): string {
  return encodeURIComponent(uid);
}

async function toApiError(res: Response): Promise<AcmeHrSystemApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body — keep null
  }
  return new AcmeHrSystemApiError(
    res.status,
    body,
    `Acme HR System API ${res.status}: ${JSON.stringify(body)}`,
  );
}