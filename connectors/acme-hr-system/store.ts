/**
 * AcmeHrSystemUserStore — adapts the skeleton's UserStore interface to the
 * Acme HR System's native LDAP-shaped API.
 *
 * This IS the connector: SCIM in (via skeleton routes), native API out
 * (via client + mapping).
 *
 * Flow:
 *   1. SCIM request → skeleton/routes/users.ts
 *   2. Skeleton calls this store's create / get / list / patch / delete
 *   3. Store calls mapping.ts to translate payloads
 *   4. Store calls client.ts to hit the Acme HR System API
 *   5. Response translates native → SCIM on the way back
 *
 * Lifecycle_policy=soft_delete (OKT-10):
 *   - PATCH active:false → client.patchUser({enabled:false})
 *   - DELETE /Users/:id → client.softDeleteUser (same outcome)
 *   Per okta-dialect.md §3 "Soft delete / deactivate (default)".
 *
 * Filter + pagination:
 *   - The native API has no server-side SCIM filter support.
 *   - All users are fetched, then filtered in-memory via scim2-parse-filter.
 *   - Case-sensitive userName eq override per OIN test suite step 16
 *     (okta-dialect.md §2 "Case sensitivity — THE Okta quirk").
 *
 * Ticket: OKT-10
 */
import { parse, filter as makePredicate } from "scim2-parse-filter";
import type { ScimPatchOperation } from "scim-patch";
import type {
  UserStore,
  ListOptions,
  ListResult,
} from "../../skeleton/store/user-store.js";
import { UserNameConflictError } from "../../skeleton/store/user-store.js";
import type { ScimUser, StoredUser } from "../../skeleton/types.js";
import type { AcmeHrSystemClient } from "./client.js";
import { AcmeHrSystemApiError } from "./client.js";
import { scimToNativeCreate, nativeToScim, scimPatchToNativePatch } from "./mapping.js";

/**
 * Extended UserStore that adds a soft-delete method so the DELETE route
 * in the server can dispatch through the same interface.
 */
export interface AcmeHrSystemUserStoreInterface extends UserStore {
  /** Soft-delete (lifecycle_policy=soft_delete): sets enabled:false. */
  softDelete(id: string): Promise<StoredUser | null>;
  /** Liveness probe for /healthz. */
  ping(): Promise<void>;
}

export class AcmeHrSystemUserStore implements AcmeHrSystemUserStoreInterface {
  constructor(private readonly client: AcmeHrSystemClient) {}

  // -------------------------------------------------------------------------
  // Liveness probe — Connector Law 8 OBSERVABLE
  // -------------------------------------------------------------------------

  async ping(): Promise<void> {
    await this.client.ping();
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    const nativeInput = scimToNativeCreate(input);
    try {
      const created = await this.client.createUser(nativeInput);
      return nativeToScim(created);
    } catch (err) {
      if (err instanceof AcmeHrSystemApiError && err.status === 409) {
        // Translate native uid conflict → skeleton's UserNameConflictError.
        // The SCIM route maps this to 409 + scimType:"uniqueness" per
        // RFC 7644 §3.12 and okta-dialect.md §8.
        throw new UserNameConflictError(nativeInput.uid);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user !== null ? nativeToScim(user) : null;
  }

  // -------------------------------------------------------------------------
  // list (with in-memory filter + pagination)
  // -------------------------------------------------------------------------

  /**
   * Fetch all users from the native API, then apply SCIM filter + pagination
   * in memory.
   *
   * The native API has no server-side filter support, so we fetch the full
   * set. For deployments with >10k users this will be slow — see
   * RUNBOOK.md §Known limitations.
   *
   * Per okta-dialect.md §4: users with active:false are EXCLUDED from the
   * default unfiltered list. Callers who need inactive users must supply an
   * explicit filter (e.g. active eq false). This mirrors Okta's documented
   * behaviour: "Okta doesn't pull in a user whose status is set to
   * active=false, even in a full import."
   */
  async list(options: ListOptions): Promise<ListResult> {
    const all = await this.client.listUsers();
    let scimUsers = all.map(nativeToScim);

    // Exclude inactive users from default list per okta-dialect.md §4.
    // If a filter is supplied, the filter itself controls visibility.
    if (options.filter === undefined || options.filter.trim() === "") {
      scimUsers = scimUsers.filter((u) => u.active !== false);
    }

    let matched = scimUsers;

    if (options.filter !== undefined && options.filter.trim() !== "") {
      let ast: unknown;
      try {
        ast = parse(options.filter);
      } catch (err) {
        // Malformed filter — re-throw; the route layer maps to 400+invalidFilter.
        // okta-dialect.md §8.
        throw err;
      }
      const predicate = makePredicate(ast as Parameters<typeof makePredicate>[0]);
      matched = scimUsers.filter(
        (u) => predicate(u as unknown as Record<string, unknown>),
      );

      // OIN test suite step 16 (Username Case Sensitivity Check) — override
      // scim2-parse-filter's default case-insensitive userName matching with
      // a case-SENSITIVE comparison.
      // Per okta-dialect.md §2 "Case sensitivity — THE Okta quirk [COSTS HOURS]".
      const override = extractSimpleStringEqAttrAndValue(ast);
      if (override !== null && override.attr === "userName") {
        matched = matched.filter((u) => u.userName === override.value);
      }
    }

    const total = matched.length;

    // RFC 7644 §3.4.2.4: startIndex is 1-based. Treat 0 as 1 per
    // okta-dialect.md §7.
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = matched.slice(from, from + options.count);

    return { resources: page, total };
  }

  // -------------------------------------------------------------------------
  // patch
  // -------------------------------------------------------------------------

  /**
   * Apply SCIM PATCH operations to a native user.
   *
   * Delegates SCIM op application to scimPatchToNativePatch (mapping.ts),
   * then issues a single PATCH to the native API.
   *
   * Sequential application of ops is handled in scimPatchToNativePatch —
   * ops are iterated in document order per RFC 7644 §3.5.2 and
   * okta-dialect.md §1 "PATCH ordering bugs".
   *
   * Returns 200 + full updated resource body per okta-dialect.md §1
   * "Status 204 on PATCH" anti-pattern.
   */
  async patch(id: string, operations: ScimPatchOperation[]): Promise<StoredUser | null> {
    const nativePatch = scimPatchToNativePatch(operations);

    // If the patch is empty (all ops were no-ops / unknown paths) we still
    // round-trip a GET to return the current state, satisfying Okta's
    // expectation of a 200 + body on PATCH even when nothing changed.
    if (Object.keys(nativePatch).length === 0) {
      return this.get(id);
    }

    const updated = await this.client.patchUser(id, nativePatch);
    return updated !== null ? nativeToScim(updated) : null;
  }

  // -------------------------------------------------------------------------
  // softDelete — lifecycle_policy=soft_delete
  // -------------------------------------------------------------------------

  /**
   * Soft-delete: flip enabled=false on the native user. Row is never deleted.
   *
   * Called by the DELETE /Users/:id route (server.ts overrides the default
   * skeleton DELETE handler). The outcome is identical to a PATCH active:false
   * — consistent policy per okta-dialect.md §3 "Anti-patterns: Inconsistency
   * between DELETE and PATCH paths".
   */
  async softDelete(id: string): Promise<StoredUser | null> {
    const updated = await this.client.softDeleteUser(id);
    return updated !== null ? nativeToScim(updated) : null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * If the AST is a top-level `<attr> eq <stringLiteral>`, extract attr + value.
 * Returns null for anything more complex. Used for the OIN step 16
 * case-sensitive userName override.
 *
 * Per okta-dialect.md §2 (case sensitivity) and skeleton/store/user-store.ts
 * for the canonical implementation.
 */
function extractSimpleStringEqAttrAndValue(
  ast: unknown,
): { attr: string; value: string } | null {
  if (typeof ast !== "object" || ast === null) return null;
  const node = ast as {
    op?: unknown;
    attrPath?: unknown;
    compValue?: unknown;
  };
  if (node.op !== "eq") return null;
  if (typeof node.attrPath !== "string") return null;
  if (typeof node.compValue !== "string") return null;
  return { attr: node.attrPath, value: node.compValue };
}