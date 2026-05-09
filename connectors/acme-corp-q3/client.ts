/**
 * HTTP client for acme-corp-q3's Internal HR System API.
 *
 * Uses Node 20+ native fetch. No external HTTP library.
 *
 * Contract (mirrors connectors/acme-hr/client.ts pattern):
 *   - 2xx         → typed response body
 *   - 404         → `null` on get / patch / delete (caller maps to 404 SCIM error)
 *   - 409         → `AcmeCorpQ3ApiError(409)` — caller maps to uniqueness conflict
 *   - other non-2xx → `AcmeCorpQ3ApiError` with status + body for dispatch
 *
 * 404-as-null is intentional: the UserStore interface returns `null` for
 * "not found" so the skeleton route layer handles the SCIM 404 response
 * without coupling to HTTP semantics. See skeleton/store/user-store.ts.
 *
 * Base URL: https://api.acme-corp-q3.example.com (prod)
 *           https://api.dev.acme-corp-q3.example.com (dev)
 * Auth: Bearer token from env ACME_CORP_Q3_API_TOKEN (OKT-60 auth_method: bearer).
 */

import type {
  AcmeCorpQ3User,
  AcmeCorpQ3UserCreate,
  AcmeCorpQ3UserPatch,
} from "./types.js";

export interface AcmeCorpQ3Client {
  listUsers(): Promise<AcmeCorpQ3User[]>;
  getUser(uid: string): Promise<AcmeCorpQ3User | null>;
  createUser(input: AcmeCorpQ3UserCreate): Promise<AcmeCorpQ3User>;
  patchUser(uid: string, patch: AcmeCorpQ3UserPatch): Promise<AcmeCorpQ3User | null>;
  /**
   * Soft-delete a user by setting enabled=false on the target.
   *
   * Lifecycle policy "soft_delete" (OKT-60): rows are NEVER hard-deleted.
   * Per okta-dialect.md §3: "DELETE handler and PATCH-active-false handler
   * MUST be policy-consistent." Both paths call this method so the policy
   * is enforced in exactly one place.
   *
   * Returns null when the user does not exist (same as patchUser 404 contract).
   */
  softDeleteUser(uid: string): Promise<AcmeCorpQ3User | null>;
}

export interface HttpAcmeCorpQ3ClientOptions {
  baseUrl: string;
  apiToken?: string;
  /** Inject a custom fetch for tests. Defaults to the Node 20 global fetch. */
  fetchImpl?: typeof fetch;
}

export class AcmeCorpQ3ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `AcmeCorpQ3 API error (status ${status})`);
    this.name = "AcmeCorpQ3ApiError";
  }
}

export class HttpAcmeCorpQ3Client implements AcmeCorpQ3Client {
  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpAcmeCorpQ3ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    if (opts.apiToken !== undefined) this.apiToken = opts.apiToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async listUsers(): Promise<AcmeCorpQ3User[]> {
    const res = await this.request("GET", "/users");
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeCorpQ3User[];
  }

  async getUser(uid: string): Promise<AcmeCorpQ3User | null> {
    const res = await this.request("GET", `/users/${encodeURIComponent(uid)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeCorpQ3User;
  }

  async createUser(input: AcmeCorpQ3UserCreate): Promise<AcmeCorpQ3User> {
    const res = await this.request("POST", "/users", input);
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeCorpQ3User;
  }

  async patchUser(
    uid: string,
    patch: AcmeCorpQ3UserPatch,
  ): Promise<AcmeCorpQ3User | null> {
    const res = await this.request("PATCH", `/users/${encodeURIComponent(uid)}`, patch);
    if (res.status === 404) return null;
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeCorpQ3User;
  }

  /**
   * Soft-delete: PATCH the target user with `{enabled: false}`.
   *
   * This is the single implementation point for the soft_delete lifecycle
   * policy. Both the SCIM DELETE route and the SCIM PATCH active=false route
   * ultimately call this method, ensuring both paths produce the same
   * end-state per okta-dialect.md §3 policy-consistency requirement.
   *
   * Returns null if the user does not exist (the SCIM DELETE route maps
   * null → 404, consistent with how patchUser handles missing users).
   */
  async softDeleteUser(uid: string): Promise<AcmeCorpQ3User | null> {
    return this.patchUser(uid, { enabled: false });
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      // Always declare Accept so the target knows we want JSON back.
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

async function toApiError(res: Response): Promise<AcmeCorpQ3ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body — swallow parse error, body stays null.
  }
  return new AcmeCorpQ3ApiError(
    res.status,
    body,
    `AcmeCorpQ3 API ${res.status}: ${JSON.stringify(body)}`,
  );
}