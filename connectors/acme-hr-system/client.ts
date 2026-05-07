/**
 * HTTP client for the Acme HR System native REST API (OKT-10).
 *
 * Uses Node 20+ native `fetch`. No external HTTP library.
 *
 * Design contract (mirrors connectors/acme-hr/client.ts):
 *   - 2xx       → typed response body
 *   - 404       → `null` on get / patch / delete (caller treats as "not found")
 *   - 409       → re-thrown as AcmeHrSystemApiError(409) — caller maps to
 *                 SCIM 409 uniqueness per RFC 7644 §3.12 + okta-dialect.md §8
 *   - other 4xx/5xx → AcmeHrSystemApiError with status + body
 *
 * 404-as-null is intentional: the UserStore interface consumed by the SCIM
 * skeleton returns `null` for "not found" (skeleton/store/user-store.ts).
 * Keeping this translation in the client keeps store.ts clean.
 *
 * Authentication: Bearer token from ACME_HR_API_TOKEN env var, passed via
 * constructor options. When undefined, requests are sent without an
 * Authorization header (dev-mode convenience only — production MUST set the
 * env var).
 *
 * Soft-delete policy (OKT-10 lifecycle_policy: soft_delete): the client
 * exposes `deactivateUser` rather than a true DELETE. The store's `delete`
 * path calls `deactivateUser` — rows are never removed from the target system.
 * See RUNBOOK.md §Lifecycle and okta-dialect.md §3 for the policy rationale.
 */

import type {
  AcmeHrSystemUser,
  AcmeHrSystemUserCreate,
  AcmeHrSystemUserPatch,
} from "./types.js";

// ── Error types ───────────────────────────────────────────────────────────────

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

// ── Client interface ──────────────────────────────────────────────────────────

export interface AcmeHrSystemClient {
  /** Shallow list — used by store.list and ping(). */
  listUsers(): Promise<AcmeHrSystemUser[]>;

  /** Returns null on 404. */
  getUser(uid: string): Promise<AcmeHrSystemUser | null>;

  /** Creates a user. Throws AcmeHrSystemApiError(409) on uid collision. */
  createUser(input: AcmeHrSystemUserCreate): Promise<AcmeHrSystemUser>;

  /**
   * Partial update. Returns null on 404.
   * Used for both attribute updates (name, email, etc.) and lifecycle
   * transitions (enabled: false for deactivation).
   */
  patchUser(
    uid: string,
    patch: AcmeHrSystemUserPatch,
  ): Promise<AcmeHrSystemUser | null>;

  /**
   * Soft-delete implementation for OKT-10 lifecycle_policy: soft_delete.
   * Sends PATCH {enabled: false} rather than DELETE — the target system
   * never removes user rows (7-year audit retention requirement).
   * Returns null when the user does not exist (idempotent).
   * Per okta-dialect.md §3: "PATCH active: false handler → mark enabled:false
   * + retain row + 200" for soft_delete policy.
   */
  deactivateUser(uid: string): Promise<AcmeHrSystemUser | null>;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface HttpAcmeHrSystemClientOptions {
  /** Base URL, e.g. https://api.acme-hr.example.com. Trailing slash stripped. */
  baseUrl: string;

  /**
   * Bearer token presented to Acme HR System's API.
   * Maps to ACME_HR_API_TOKEN env var. Omit for dev-mode (no auth header sent).
   */
  apiToken?: string;

  /**
   * Fetch implementation override. Defaults to the Node 20+ global `fetch`.
   * Injected in unit tests to avoid real HTTP.
   */
  fetchImpl?: typeof fetch;
}

// ── Implementation ────────────────────────────────────────────────────────────

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
    const res = await this.request("PATCH", `/users/${enc(uid)}`, patch);
    if (res.status === 404) return null;
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeHrSystemUser;
  }

  /**
   * Soft-delete: PATCH {enabled: false}. Returns null when the user does
   * not exist (idempotent for DELETE path per okta-dialect.md §3).
   */
  async deactivateUser(uid: string): Promise<AcmeHrSystemUser | null> {
    return this.patchUser(uid, { enabled: false });
  }

  // ── Private ────────────────────────────────────────────────────────────────

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
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }

    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function enc(s: string): string {
  return encodeURIComponent(s);
}

async function toApiError(res: Response): Promise<AcmeHrSystemApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error body — keep body as null.
  }
  return new AcmeHrSystemApiError(
    res.status,
    body,
    `Acme HR System API ${res.status}: ${JSON.stringify(body)}`,
  );
}