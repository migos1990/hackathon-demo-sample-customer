/**
 * HTTP client for the BigCorpHR native API.
 *
 * Uses Node 20+ native fetch — no external HTTP library.
 *
 * Contract:
 *   - 2xx        → typed response body
 *   - 404        → `null` on get / patchUser (callers treat as "not found")
 *   - non-2xx    → `BigCorpHrApiError` thrown; caller dispatches
 *
 * The 404-as-null convention keeps store.ts free of HTTP semantics and
 * aligns with skeleton/store/user-store.ts UserStore interface which
 * returns null for missing resources.
 *
 * Auth: Bearer token from env var BIGCORP_HR_API_TOKEN per ticket OKT-7.
 * okta-dialect.md §9 (Authentication).
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
  /**
   * Partial update.  Returns null when uid is not found (404).
   * For soft_delete: patchUser is also called by deleteUser in the store
   * to flip enabled=false rather than issuing a real DELETE.
   * okta-dialect.md §3.
   */
  patchUser(
    uid: string,
    patch: BigCorpHrUserPatch,
  ): Promise<BigCorpHrUser | null>;
}

export interface HttpBigCorpHrClientOptions {
  baseUrl: string;
  /** Bearer token presented to BigCorpHR.  From env BIGCORP_HR_API_TOKEN. */
  apiToken?: string;
  /** Injectable for tests; defaults to global fetch in Node 20+. */
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
    const res = await this.request(
      "GET",
      `/users/${encodeURIComponent(uid)}`,
    );
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

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.apiToken !== undefined)
      headers["authorization"] = `Bearer ${this.apiToken}`;

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
    // Non-JSON body — surface the raw status; don't re-throw parse error.
  }
  return new BigCorpHrApiError(
    res.status,
    body,
    `BigCorpHR API ${res.status}: ${JSON.stringify(body)}`,
  );
}