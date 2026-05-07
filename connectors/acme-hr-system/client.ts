/**
 * HTTP client for Acme HR System's native REST API.
 *
 * Design contract (mirrors connectors/acme-hr/client.ts):
 *   - Uses Node 20+ native fetch — no external HTTP library.
 *   - 2xx       → typed response body
 *   - 404       → null on get / patch / delete (caller maps to SCIM 404)
 *   - 409       → AcmeHrSystemApiError(409) — caller maps to SCIM uniqueness
 *   - other 4xx/5xx → AcmeHrSystemApiError with status + body
 *
 * Auth: Bearer token from ACME_HR_API_TOKEN env var (ticket OKT-10,
 * auth_method: "bearer", auth_credential_env_var: "ACME_HR_API_TOKEN").
 *
 * Soft-delete: DELETE is implemented (required_ops.users_delete: true in
 * OKT-10) but the store maps it to a PATCH enabled:false on the target,
 * consistent with lifecycle_policy: "soft_delete". The client exposes
 * both patchUser and deleteUser; the store decides which to call.
 * okta-dialect.md §3.
 */
import type {
  AcmeHrSystemUser,
  AcmeHrSystemUserCreate,
  AcmeHrSystemUserPatch,
} from "./types.js";

// ─── Public interface ────────────────────────────────────────────────────────

export interface AcmeHrSystemClient {
  /** Cheap reachability probe for /healthz. */
  ping(): Promise<void>;
  listUsers(): Promise<AcmeHrSystemUser[]>;
  getUser(uid: string): Promise<AcmeHrSystemUser | null>;
  createUser(input: AcmeHrSystemUserCreate): Promise<AcmeHrSystemUser>;
  patchUser(
    uid: string,
    patch: AcmeHrSystemUserPatch,
  ): Promise<AcmeHrSystemUser | null>;
  /**
   * Hard-delete on the target (used ONLY when some external process requires
   * it — not called by the store under normal lifecycle, which soft-deletes
   * via patchUser instead). Included to satisfy required_ops.users_delete.
   */
  deleteUser(uid: string): Promise<boolean>;
}

export interface HttpAcmeHrSystemClientOptions {
  baseUrl: string;
  /** Bearer token presented to the native API. Omit for dev-mode. */
  apiToken?: string;
  /** Inject alternate fetch for tests. Defaults to global fetch (Node 20+). */
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

// ─── Implementation ──────────────────────────────────────────────────────────

export class HttpAcmeHrSystemClient implements AcmeHrSystemClient {
  private readonly baseUrl: string;
  private readonly apiToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpAcmeHrSystemClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiToken = opts.apiToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async ping(): Promise<void> {
    // HEAD /users is the lightest probe. Fall back to GET /users?count=1
    // if the target doesn't implement HEAD (undocumented in OKT-10).
    // Conservative: use GET /users with a small count to verify the API
    // is responsive. Real customer apps with dedicated /ping or /health
    // should override this with a cheaper call.
    const res = await this.request("GET", "/users?count=1");
    if (!res.ok) throw await toApiError(res);
    // Drain the body to avoid connection leaks (Node fetch keeps the
    // socket open until the body is consumed or aborted).
    await res.json().catch(() => null);
  }

  async listUsers(): Promise<AcmeHrSystemUser[]> {
    const res = await this.request("GET", "/users");
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeHrSystemUser[];
  }

  async getUser(uid: string): Promise<AcmeHrSystemUser | null> {
    const res = await this.request("GET", `/users/${encode(uid)}`);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
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
    const res = await this.request("PATCH", `/users/${encode(uid)}`, patch);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeHrSystemUser;
  }

  async deleteUser(uid: string): Promise<boolean> {
    const res = await this.request("DELETE", `/users/${encode(uid)}`);
    if (res.status === 404) {
      await res.body?.cancel();
      return false;
    }
    if (!res.ok) throw await toApiError(res);
    await res.body?.cancel();
    return true;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.apiToken !== undefined) {
      // okta-dialect.md §9: Bearer scheme.
      headers["authorization"] = `Bearer ${this.apiToken}`;
    }

    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function encode(s: string): string {
  return encodeURIComponent(s);
}

async function toApiError(res: Response): Promise<AcmeHrSystemApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    try {
      body = await res.text();
    } catch {
      // ignore — body unreadable
    }
  }
  return new AcmeHrSystemApiError(
    res.status,
    body,
    `Acme HR System API ${res.status}: ${JSON.stringify(body)}`,
  );
}