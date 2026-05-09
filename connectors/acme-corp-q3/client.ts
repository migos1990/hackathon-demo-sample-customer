/**
 * HTTP client for the AcmeCorpQ3 HR API.
 *
 * Uses Node 20+ native fetch — no external HTTP library.
 *
 * Contract:
 *   - 2xx       → typed response body
 *   - 404       → null on get / patch / softDelete (caller maps to SCIM 404)
 *   - 409       → AcmeCorpQ3ApiError(409) for uid conflicts (caller maps to SCIM 409+uniqueness)
 *   - other non-2xx → AcmeCorpQ3ApiError with status + body; caller dispatches
 *
 * Soft-delete policy (ticket OKT-57): DELETE /Users/:id on the SCIM side
 * resolves to PATCH enabled:false on this client — there is NO deleteUser()
 * method. The SCIM DELETE route calls softDeleteUser() which calls patchUser()
 * with {enabled:false}. This enforces the okta-dialect.md §3 requirement that
 * "same customer policy MUST yield identical outcomes regardless of which
 * endpoint Okta hits."
 *
 * Auth: Bearer token from env var ACME_CORP_Q3_API_TOKEN per ticket OKT-57.
 * Token is injected at construction; never read from process.env inside here
 * (SECRETS-OUT law — env reading happens in start.ts only).
 */

import type {
  AcmeCorpQ3User,
  AcmeCorpQ3UserCreate,
  AcmeCorpQ3UserPatch,
} from "./types.js";

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface AcmeCorpQ3Client {
  /** Cheap reachability probe for /healthz. */
  listUsers(): Promise<AcmeCorpQ3User[]>;
  getUser(uid: string): Promise<AcmeCorpQ3User | null>;
  createUser(input: AcmeCorpQ3UserCreate): Promise<AcmeCorpQ3User>;
  patchUser(uid: string, patch: AcmeCorpQ3UserPatch): Promise<AcmeCorpQ3User | null>;
  /**
   * Soft-delete implementation. Sets enabled:false, never deletes the row.
   * Returns null when uid not found (SCIM route returns 404).
   * Per okta-dialect.md §3: same end-state as PATCH active:false.
   */
  softDeleteUser(uid: string): Promise<AcmeCorpQ3User | null>;
}

export interface HttpAcmeCorpQ3ClientOptions {
  /** Base URL, e.g. https://api.acme-corp-q3.example.com */
  baseUrl: string;
  /** Bearer token. Omit for dev-mode (no auth header sent). */
  apiToken?: string;
  /**
   * Override fetch implementation. Defaults to global fetch (Node 20+).
   * Tests inject a mock here to avoid real HTTP calls.
   */
  fetchImpl?: typeof fetch;
}

// ─── Error class ─────────────────────────────────────────────────────────────

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

// ─── Implementation ───────────────────────────────────────────────────────────

export class HttpAcmeCorpQ3Client implements AcmeCorpQ3Client {
  private readonly baseUrl: string;
  private readonly apiToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpAcmeCorpQ3ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiToken = opts.apiToken;
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
   * Soft-delete: PATCH enabled:false, never delete the row.
   * okta-dialect.md §3: "DELETE handler and PATCH-active-false handler MUST
   * be policy-consistent."
   */
  async softDeleteUser(uid: string): Promise<AcmeCorpQ3User | null> {
    return this.patchUser(uid, { enabled: false });
  }

  // ─── Private ───────────────────────────────────────────────────────────────

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

// ─── Helper ───────────────────────────────────────────────────────────────────

async function toApiError(res: Response): Promise<AcmeCorpQ3ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error body — leave body as null.
  }
  return new AcmeCorpQ3ApiError(
    res.status,
    body,
    `AcmeCorpQ3 API ${res.status}: ${JSON.stringify(body)}`,
  );
}