/**
 * HTTP client for the Acme HR System native API (OKT-10).
 *
 * Uses Node 20+ native fetch. No external HTTP dependency.
 *
 * Contract:
 *   - 2xx       → typed response body
 *   - 404       → `null` on get/patch (caller translates to SCIM 404)
 *   - non-2xx   → `AcmeHrSystemApiError` thrown; caller dispatches
 *
 * The 404→null convention keeps the UserStore implementation (store.ts)
 * free of HTTP-status-code branching — it just checks for null and maps
 * to the skeleton's SCIM 404 response per RFC 7644 §3.4.2.
 *
 * Authentication: bearer token via `Authorization: Bearer <token>` header
 * per ticket OKT-10 (auth_method=bearer). Token is injected at construction
 * from the ACME_HR_API_TOKEN env var — never hardcoded. See RUNBOOK.md §Env.
 *
 * Citations:
 *   - okta-dialect.md §9 (auth — bearer token)
 *   - okta-dialect.md §3 (soft-delete: DELETE → patch enabled:false, not
 *     remove row). The DELETE path on this client sets enabled:false rather
 *     than calling a DELETE endpoint on the target, because OKT-10 lifecycle
 *     policy is soft_delete.
 */
import type {
  AcmeHrSystemUser,
  AcmeHrSystemUserCreate,
  AcmeHrSystemUserPatch,
} from "./types.js";

export interface AcmeHrSystemClientOptions {
  /** Base URL of the Acme HR System API, e.g. https://api.acme-hr.example.com */
  baseUrl: string;
  /** Bearer token presented to the customer's API. Omit for dev-mode (no auth). */
  apiToken?: string;
  /**
   * Override the fetch implementation (for unit tests / MSW / node-fetch shim).
   * Defaults to the ambient global `fetch` available in Node 20+.
   */
  fetchImpl?: typeof fetch;
}

export interface AcmeHrSystemClient {
  /** Fetch all users. Used for in-memory filter + pagination in store.ts. */
  listUsers(): Promise<AcmeHrSystemUser[]>;
  /** Fetch a single user by uid. Returns null on 404. */
  getUser(uid: string): Promise<AcmeHrSystemUser | null>;
  /** Create a new user. Throws AcmeHrSystemApiError(409) on uid collision. */
  createUser(input: AcmeHrSystemUserCreate): Promise<AcmeHrSystemUser>;
  /**
   * Patch an existing user. Returns null on 404 (user not found).
   *
   * Note: this sends a partial PATCH to the customer's API — only the
   * fields present in `patch` are transmitted. The customer's API must
   * support partial PATCH (confirmed in ticket).
   */
  patchUser(
    uid: string,
    patch: AcmeHrSystemUserPatch,
  ): Promise<AcmeHrSystemUser | null>;
  /**
   * Soft-delete a user (OKT-10 lifecycle_policy=soft_delete).
   *
   * SCIM DELETE /Users/:id arrives at the store, which calls this method.
   * Per okta-dialect.md §3: Okta's primary deprovisioning signal is
   * `PATCH active:false`, NOT DELETE. However, the SCIM spec (RFC 7644
   * §3.6) requires a DELETE endpoint. We implement it as a soft-delete
   * (enabled:false) so both paths yield the same end-state per the
   * soft_delete policy.
   *
   * Returns null if the user was not found (already deleted or never existed).
   */
  softDeleteUser(uid: string): Promise<AcmeHrSystemUser | null>;
}

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

export class HttpAcmeHrSystemClient implements AcmeHrSystemClient {
  private readonly baseUrl: string;
  private readonly apiToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AcmeHrSystemClientOptions) {
    // Strip trailing slashes so path concatenation is always clean.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiToken = opts.apiToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async listUsers(): Promise<AcmeHrSystemUser[]> {
    const res = await this.request("GET", "/users");
    if (!res.ok) throw await this.toApiError(res);
    return (await res.json()) as AcmeHrSystemUser[];
  }

  async getUser(uid: string): Promise<AcmeHrSystemUser | null> {
    const res = await this.request("GET", `/users/${encodeURIComponent(uid)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await this.toApiError(res);
    return (await res.json()) as AcmeHrSystemUser;
  }

  async createUser(input: AcmeHrSystemUserCreate): Promise<AcmeHrSystemUser> {
    const res = await this.request("POST", "/users", input);
    if (!res.ok) throw await this.toApiError(res);
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
    if (!res.ok) throw await this.toApiError(res);
    return (await res.json()) as AcmeHrSystemUser;
  }

  async softDeleteUser(uid: string): Promise<AcmeHrSystemUser | null> {
    // Soft-delete = set enabled:false. Per OKT-10 lifecycle_policy=soft_delete
    // and okta-dialect.md §3: rows are never removed.
    return this.patchUser(uid, { enabled: false });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

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
    if (this.apiToken !== undefined && this.apiToken !== "") {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }

    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }

  private async toApiError(res: Response): Promise<AcmeHrSystemApiError> {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Non-JSON body — leave body as null
    }
    return new AcmeHrSystemApiError(
      res.status,
      body,
      `Acme HR System API ${res.status}: ${JSON.stringify(body)}`,
    );
  }
}