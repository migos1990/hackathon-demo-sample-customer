/**
 * HTTP client for the AcmeCorpQ3 internal HR system API.
 *
 * Uses Node 20+ native fetch — no external HTTP library.
 *
 * Contract (mirrors docs/patterns/ldap.md §1 client pattern):
 *   - 2xx       → typed response body
 *   - 404       → null on get/patch (store.ts maps this to SCIM 404)
 *   - 409       → AcmeCorpQ3ApiError(409) — store.ts maps to UserNameConflictError
 *   - non-2xx   → AcmeCorpQ3ApiError with status + body; store dispatches
 *
 * Auth: Bearer token from ACME_CORP_Q3_API_TOKEN env var.
 * docs/okta-dialect.md §9 (auth), OKT-57 (auth_method:bearer,
 * auth_credential_env_var:ACME_CORP_Q3_API_TOKEN).
 *
 * No secrets in this file. Token is injected via options at runtime.
 * Connector Law 4 SECRETS-OUT.
 *
 * Observability: every request/response pair is logged with method, path,
 * and status. docs/okta-dialect.md §9 + Connector Law 8 OBSERVABLE.
 */
import type {
  AcmeCorpQ3User,
  AcmeCorpQ3UserCreate,
  AcmeCorpQ3UserPatch,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface AcmeCorpQ3Client {
  /** List all users. Used for in-memory filter + healthz probe. */
  listUsers(): Promise<AcmeCorpQ3User[]>;
  /** Get single user by uid. Returns null on 404. */
  getUser(uid: string): Promise<AcmeCorpQ3User | null>;
  /** Create user. Throws AcmeCorpQ3ApiError(409) on uid conflict. */
  createUser(input: AcmeCorpQ3UserCreate): Promise<AcmeCorpQ3User>;
  /**
   * Patch user. Returns null on 404 (user not found).
   * Used for both attribute updates and the soft-delete lifecycle
   * (enabled=false) per lifecycle_policy=soft_delete, OKT-57.
   * docs/okta-dialect.md §3.
   */
  patchUser(
    uid: string,
    patch: AcmeCorpQ3UserPatch,
  ): Promise<AcmeCorpQ3User | null>;
  /**
   * Hard delete by uid. Per lifecycle_policy=soft_delete this is NOT
   * called by the connector's SCIM DELETE handler (which instead PATCHes
   * enabled=false). This method exists for admin / test tooling only.
   * docs/okta-dialect.md §3.
   */
  deleteUser(uid: string): Promise<void>;
}

export interface HttpAcmeCorpQ3ClientOptions {
  /** Base URL of the customer's HR API (no trailing slash). */
  baseUrl: string;
  /** Bearer token for the customer's API. Omit in dev for open endpoints. */
  apiToken?: string;
  /**
   * Structured logger — any object with .info/.warn/.error methods.
   * Defaults to console. Connector Law 8 OBSERVABLE.
   */
  logger?: Logger;
  /** Override fetch for unit tests. Defaults to Node 20+ global fetch. */
  fetchImpl?: typeof fetch;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class HttpAcmeCorpQ3Client implements AcmeCorpQ3Client {
  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(opts: HttpAcmeCorpQ3ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    if (opts.apiToken !== undefined) this.apiToken = opts.apiToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = opts.logger ?? {
      info: (msg, meta) =>
        console.log(JSON.stringify({ level: "info", msg, ...meta })),
      warn: (msg, meta) =>
        console.warn(JSON.stringify({ level: "warn", msg, ...meta })),
      error: (msg, meta) =>
        console.error(JSON.stringify({ level: "error", msg, ...meta })),
    };
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

  async deleteUser(uid: string): Promise<void> {
    const res = await this.request(
      "DELETE",
      `/users/${encodeURIComponent(uid)}`,
    );
    if (res.status === 404 || res.status === 204) return;
    if (!res.ok) throw await toApiError(res);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (this.apiToken !== undefined) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }

    // Connector Law 8 OBSERVABLE — log every outbound request.
    this.logger.info("acme-corp-q3 client request", { method, path });

    const res = await this.fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

    this.logger.info("acme-corp-q3 client response", {
      method,
      path,
      status: res.status,
    });

    return res;
  }
}

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