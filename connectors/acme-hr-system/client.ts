/**
 * HTTP client for Acme HR System's native API.
 *
 * Uses Node 20+ native fetch. No external HTTP dependency.
 *
 * Contract (mirrors connectors/acme-hr/client.ts conventions):
 *   - 2xx       → typed response body
 *   - 404       → null on get / patch (caller skips the network error path)
 *   - 409       → AcmeHrSystemApiError(409) — caller maps to userName conflict
 *   - non-2xx   → AcmeHrSystemApiError with status + body
 *
 * The 404-as-null convention keeps store.ts aligned with the UserStore
 * interface, which returns null for "not found" rather than throwing.
 *
 * Auth: Bearer token from env var ACME_HR_API_TOKEN (Law 4 SECRETS-OUT).
 * See RUNBOOK.md for env var documentation.
 *
 * Base URL selection per environment:
 *   dev:     https://dev.acme-hr.example.com
 *   staging: https://staging.acme-hr.example.com
 *   prod:    https://api.acme-hr.example.com
 * Driven by ACME_HR_SYSTEM_BASE_URL env var — defaults to prod URL.
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
  /**
   * Patch user by uid. Returns null on 404 (user not found in target).
   * Throws AcmeHrSystemApiError on other non-2xx responses.
   */
  patchUser(
    uid: string,
    patch: AcmeHrSystemUserPatch,
  ): Promise<AcmeHrSystemUser | null>;
  /**
   * Soft-delete: set enabled=false on the user. Returns null on 404.
   * Named separately from patchUser for readability in store.ts's
   * delete() handler — under the hood it issues the same PATCH.
   *
   * Lifecycle policy: SOFT DELETE (okta-dialect.md §3). The DELETE /Users/:id
   * SCIM endpoint maps here — no row is ever removed from Acme HR System.
   */
  deactivateUser(uid: string): Promise<AcmeHrSystemUser | null>;
}

export interface HttpAcmeHrSystemClientOptions {
  baseUrl: string;
  apiToken?: string;
  /** Override for tests — defaults to global `fetch` in Node 20+. */
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
    // Strip trailing slash so path concatenation is always "/path" form.
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
   * Soft-delete implementation — patches enabled=false.
   * Per okta-dialect.md §3: Okta deprovisioning signal is `active=false`
   * via PATCH, NOT DELETE. When the SCIM DELETE endpoint is called, we
   * honour the soft-delete policy identically (same outcome, different
   * SCIM entry point).
   */
  async deactivateUser(uid: string): Promise<AcmeHrSystemUser | null> {
    return this.patchUser(uid, { enabled: false });
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      // Accept SCIM+JSON or plain JSON from the native API.
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

async function toApiError(res: Response): Promise<AcmeHrSystemApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON response body — treat as opaque.
  }
  return new AcmeHrSystemApiError(
    res.status,
    body,
    `Acme HR System API ${res.status}: ${JSON.stringify(body)}`,
  );
}