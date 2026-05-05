/**
 * HTTP client for AcmeHR-lite (and, by generalization, the target-app
 * boundary every generated SCIM connector crosses).
 *
 * Uses Node 20+ native fetch. No external HTTP lib.
 *
 * Contract:
 *   - 2xx       → typed response body
 *   - 404       → `null` on get / patch (documented interface behavior)
 *   - non-2xx   → `AcmeHrApiError` with status + body, caller dispatches
 *
 * 404-as-null is intentional: the UserStore interface consumed by the
 * SCIM skeleton returns `null` for "not found" (see skeleton/store/
 * user-store.ts lines 34-39). Letting the client handle this translation
 * keeps store.ts simple and keeps HTTP semantics out of its code.
 */
import type {
  AcmeHrUser,
  AcmeHrUserCreate,
  AcmeHrUserPatch,
} from "../../demo-targets/acme-hr-lite/types.js";

export interface AcmeHrClient {
  listUsers(): Promise<AcmeHrUser[]>;
  getUser(uid: string): Promise<AcmeHrUser | null>;
  createUser(input: AcmeHrUserCreate): Promise<AcmeHrUser>;
  patchUser(uid: string, patch: AcmeHrUserPatch): Promise<AcmeHrUser | null>;
}

export interface HttpAcmeHrClientOptions {
  baseUrl: string;
  apiToken?: string;
  /** Override for tests; defaults to the ambient global `fetch` in Node 20+. */
  fetchImpl?: typeof fetch;
}

export class AcmeHrApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `AcmeHR API error (status ${status})`);
    this.name = "AcmeHrApiError";
  }
}

export class HttpAcmeHrClient implements AcmeHrClient {
  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpAcmeHrClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    if (opts.apiToken !== undefined) this.apiToken = opts.apiToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async listUsers(): Promise<AcmeHrUser[]> {
    const res = await this.request("GET", "/users");
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeHrUser[];
  }

  async getUser(uid: string): Promise<AcmeHrUser | null> {
    const res = await this.request("GET", `/users/${encodeURIComponent(uid)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeHrUser;
  }

  async createUser(input: AcmeHrUserCreate): Promise<AcmeHrUser> {
    const res = await this.request("POST", "/users", input);
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeHrUser;
  }

  async patchUser(uid: string, patch: AcmeHrUserPatch): Promise<AcmeHrUser | null> {
    const res = await this.request("PATCH", `/users/${encodeURIComponent(uid)}`, patch);
    if (res.status === 404) return null;
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as AcmeHrUser;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.apiToken !== undefined) headers["authorization"] = `Bearer ${this.apiToken}`;

    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }
}

async function toApiError(res: Response): Promise<AcmeHrApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Ignore — non-JSON body
  }
  return new AcmeHrApiError(res.status, body, `AcmeHR API ${res.status}: ${JSON.stringify(body)}`);
}
