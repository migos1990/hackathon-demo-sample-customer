/**
 * HTTP client for the Acme Corp Q3 Internal HR System API.
 *
 * Uses Node 20+ native fetch. No external HTTP library.
 *
 * Contract:
 *   - 2xx         → typed response body
 *   - 404 on GET/PATCH → `null` (caller treats as "not found")
 *   - 409 on POST → `AcmeCorpQ3ApiError` with status 409 (caller maps to
 *                    SCIM 409 + scimType:uniqueness per RFC 7644 §3.12 and
 *                    okta-dialect.md §8)
 *   - other non-2xx → `AcmeCorpQ3ApiError` with status + body; caller decides
 *
 * 404-as-null is intentional: the UserStore interface (skeleton/store/
 * user-store.ts) returns null for "not found", keeping HTTP semantics
 * out of the store layer.
 *
 * Authentication: Bearer token per ticket OKT-54 (auth_method: bearer).
 * Token is supplied via environment variable ACME_CORP_Q3_API_TOKEN
 * (auth_credential_env_var in ticket). Never hard-coded — Law 4 SECRETS-OUT.
 * See okta-dialect.md §9 (Authentication).
 *
 * Soft-delete note (ticket OKT-54, lifecycle_policy: soft_delete):
 * The DELETE /users/:uid endpoint is exposed (required_ops.users_delete:true)
 * but the connector translates Okta's PATCH active:false signal into a native
 * PATCH {enabled:false}, not a DELETE. The DELETE endpoint on the HR API is
 * NOT called during normal Okta deprovisioning — it exists only for admin
 * hard-removal and is surfaced here to satisfy the connector interface.
 * Per okta-dialect.md §3: Okta never calls DELETE itself during lifecycle;
 * it uses PATCH active:false.
 */
import type {
  AcmeCorpQ3User,
  AcmeCorpQ3UserCreate,
  AcmeCorpQ3UserPatch,
} from "./types.js";

// ─── Error type ──────────────────────────────────────────────────────────────

export class AcmeCorpQ3ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `Acme Corp Q3 HR API error (HTTP ${status})`);
    this.name = "AcmeCorpQ3ApiError";
  }
}

// ─── Client interface ────────────────────────────────────────────────────────

export interface AcmeCorpQ3Client {
  /** List all users. Used by store.list() and store.ping(). */
  listUsers(): Promise<AcmeCorpQ3User[]>;
  /** Get a single user by uid. Returns null on 404. */
  getUser(uid: string): Promise<AcmeCorpQ3User | null>;
  /** Create a new user. Throws AcmeCorpQ3ApiError(409) on uid conflict. */
  createUser(input: AcmeCorpQ3UserCreate): Promise<AcmeCorpQ3User>;
  /**
   * Partial-update a user. Returns null on 404.
   *
   * Soft-delete lifecycle (ticket OKT-54): when Okta deprovisions a user,
   * the store calls this with {enabled: false}. The HR API retains the row.
   * See okta-dialect.md §3 (Soft vs hard delete).
   */
  patchUser(uid: string, patch: AcmeCorpQ3UserPatch): Promise<AcmeCorpQ3User | null>;
  /**
   * Hard-delete a user by uid. Returns null on 404 (idempotent for callers).
   *
   * WARNING: This is NOT called by Okta's normal deprovisioning flow.
   * Okta uses PATCH active:false (okta-dialect.md §3). This method exists
   * to satisfy required_ops.users_delete:true in ticket OKT-54 and for
   * admin-initiated forced removal. The store.delete() implementation maps
   * Okta's DELETE signal back to a PATCH {enabled:false} to preserve the
   * soft_delete policy.
   */
  deleteUser(uid: string): Promise<void | null>;
}

// ─── HTTP implementation ─────────────────────────────────────────────────────

export interface HttpAcmeCorpQ3ClientOptions {
  /** Base URL of the HR API, e.g. https://api.acme-corp-q3.example.com */
  baseUrl: string;
  /**
   * Bearer token for the HR API. Sourced from ACME_CORP_Q3_API_TOKEN env var.
   * Omit in dev to skip auth (HR API must also be in dev/no-auth mode).
   * Law 4 SECRETS-OUT: never hard-code.
   */
  apiToken?: string;
  /** Injectable fetch implementation — for tests. Defaults to global fetch (Node 20+). */
  fetchImpl?: typeof fetch;
}

export class HttpAcmeCorpQ3Client implements AcmeCorpQ3Client {
  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpAcmeCorpQ3ClientOptions) {
    // Strip trailing slashes so path concatenation is consistent.
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
    const res = await this.request(
      "PATCH",
      `/users/${encodeURIComponent(uid)}`,
      patch,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeCorpQ3User;
  }

  async deleteUser(uid: string): Promise<void | null> {
    const res = await this.request(
      "DELETE",
      `/users/${encodeURIComponent(uid)}`,
    );
    if (res.status === 404) return null;
    if (res.status === 204 || res.status === 200) return;
    if (!res.ok) throw await toApiError(res);
  }

  // ── Private ──────────────────────────────────────────────────────────────

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
      // Bearer auth per ticket OKT-54 + okta-dialect.md §9.
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }

    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }
}

// ─── Private helpers ─────────────────────────────────────────────────────────

async function toApiError(res: Response): Promise<AcmeCorpQ3ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body — body stays null.
  }
  return new AcmeCorpQ3ApiError(
    res.status,
    body,
    `Acme Corp Q3 HR API ${res.status}: ${JSON.stringify(body)}`,
  );
}