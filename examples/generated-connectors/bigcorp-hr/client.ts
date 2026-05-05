/**
 * HTTP client for BigCorpHR's API.
 *
 * Uses Node 20+ native fetch. No external HTTP library.
 *
 * Contract:
 *   - 2xx        → typed response body
 *   - 404        → `null` on get / patch (interface contract, not exception)
 *   - 409        → BigCorpHrApiError(409) — caller maps to SCIM uniqueness
 *   - other non-2xx → BigCorpHrApiError with status + body, caller dispatches
 *
 * 404-as-null aligns with the UserStore interface in skeleton/store/user-store.ts
 * which returns null for "not found", keeping HTTP semantics out of store.ts.
 *
 * Soft-delete policy (ticket SCIM-LIVE-PROBE):
 *   `deleteUser` sends PATCH {enabled: false} rather than DELETE, matching
 *   okta-dialect.md §3 "soft_delete" lifecycle policy. The BigCorpHR API
 *   does not expose a DELETE endpoint (retention requirements); the connector
 *   maps the SCIM DELETE verb onto a deactivation PATCH.
 *
 * Base URL: https://api.bigcorp-hr.example.com (ticket SCIM-LIVE-PROBE)
 * Auth: Bearer token from env var BIGCORP_HR_API_TOKEN (ticket + okta-dialect.md §9).
 */

import type {
  BigCorpHrUser,
  BigCorpHrUserCreate,
  BigCorpHrUserPatch,
} from "./types.js";

export interface BigCorpHrClient {
  listUsers(): Promise<BigCorpHrUser[]>;
  getUser(uid: string): Promise<BigCorpHrUser | null>;
  createUser(input: BigCorpHrUserCreate): Promise<BigCorpHrUser>;
  patchUser(
    uid: string,
    patch: BigCorpHrUserPatch,
  ): Promise<BigCorpHrUser | null>;
  /**
   * Soft-delete: marks user disabled rather than removing.
   * Returns null when uid is not found (404 from target).
   * Per okta-dialect.md §3 soft_delete policy: row MUST NOT be hard-removed.
   */
  deleteUser(uid: string): Promise<BigCorpHrUser | null>;
}

export interface HttpBigCorpHrClientOptions {
  baseUrl: string;
  apiToken?: string;
  /** Override fetch for tests; defaults to ambient global fetch (Node 20+). */
  fetchImpl?: typeof fetch;
}

export class BigCorpHrApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `BigCorpHR API error (status ${status})`);
    this.name = "BigCorpHrApiError";
  }
}

export class HttpBigCorpHrClient implements BigCorpHrClient {
  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpBigCorpHrClientOptions) {
    // Strip trailing slashes to avoid double-slash on path concat.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    if (opts.apiToken !== undefined) this.apiToken = opts.apiToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async listUsers(): Promise<BigCorpHrUser[]> {
    const res = await this.request("GET", "/users");
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as BigCorpHrUser[];
  }

  async getUser(uid: string): Promise<BigCorpHrUser | null> {
    const res = await this.request("GET", `/users/${encodeURIComponent(uid)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as BigCorpHrUser;
  }

  async createUser(input: BigCorpHrUserCreate): Promise<BigCorpHrUser> {
    const res = await this.request("POST", "/users", input);
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as BigCorpHrUser;
  }

  async patchUser(
    uid: string,
    patch: BigCorpHrUserPatch,
  ): Promise<BigCorpHrUser | null> {
    const res = await this.request(
      "PATCH",
      `/users/${encodeURIComponent(uid)}`,
      patch,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as BigCorpHrUser;
  }

  /**
   * Soft-delete implementation per okta-dialect.md §3 (soft_delete policy,
   * ticket SCIM-LIVE-PROBE lifecycle_policy: soft_delete):
   *   - Does NOT call DELETE on BigCorpHR's API (row must be retained for
   *     compliance audit — 7-year retention assumption matching AcmeHR pattern).
   *   - Sends PATCH {enabled: false} instead.
   *   - Returns null when uid is not found (idempotent — already gone / never
   *     existed; caller maps to 404 SCIM response).
   *
   * okta-dialect.md §3 anti-pattern warning: "Hard-deleting on `active:false`
   * when the customer actually wanted soft-delete — breaks audit." This
   * implementation avoids that by never calling DELETE on the target.
   */
  async deleteUser(uid: string): Promise<BigCorpHrUser | null> {
    return this.patchUser(uid, { enabled: false });
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      // Accept SCIM+JSON and plain JSON from target.
      accept: "application/json",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.apiToken !== undefined) {
      // Per okta-dialect.md §9: bearer token auth — same scheme the skeleton
      // uses for inbound requests from Okta.
      headers["authorization"] = `Bearer ${this.apiToken}`;
    }

    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }
}

async function toApiError(res: Response): Promise<BigCorpHrApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body — keep body as null, still wrap in typed error.
  }
  return new BigCorpHrApiError(
    res.status,
    body,
    `BigCorpHR API ${res.status}: ${JSON.stringify(body)}`,
  );
}