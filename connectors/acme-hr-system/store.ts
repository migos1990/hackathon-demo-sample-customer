/**
 * AcmeHrSystemUserStore — UserStore implementation for the Acme HR System
 * connector (ticket OKT-10).
 *
 * Implements the skeleton's UserStore interface so the skeleton's routes
 * (skeleton/routes/users.ts) call this store without knowing anything about
 * the native API.
 *
 * Data flow:
 *   SCIM request
 *     → skeleton/routes/users.ts
 *     → this store (create / get / list / patch)
 *     → mapping.ts (SCIM ↔ native translation)
 *     → client.ts (HTTP calls to Acme HR System)
 *     → mapping.ts (native → SCIM on response)
 *     → skeleton route returns 200/201/404 etc.
 *
 * Okta-dialect citations:
 *
 * §1  PATCH — multi-op, sequential application, 200 with body.
 *     store.patch() delegates to scimPatchToAcmeHrSystemPatch() which iterates
 *     ops in document order, then issues a SINGLE merged PATCH to the target.
 *
 * §2  Filter — case-sensitive userName eq override for OIN step 16.
 *     list() applies the scim2-parse-filter library then overrides with an
 *     exact-string match for simple `userName eq <literal>` patterns.
 *
 * §3  Soft delete — DELETE maps to deactivateUser (PATCH {enabled:false}).
 *     Both SCIM PATCH active:false and SCIM DELETE converge on enabled:false.
 *
 * §4  Reactivation — PATCH active:true on already-active user is idempotent
 *     (enabled:true PATCH on target is a no-op).
 *
 * §7  Pagination — 1-based startIndex; treat 0 as 1; honest itemsPerPage.
 *
 * §8  Error envelope — UserNameConflictError → 409+uniqueness (handled in
 *     skeleton/routes/users.ts; this store throws the right typed error).
 *
 * Filter strategy: Acme HR System has no server-side SCIM filter API.
 * We fetch all users and filter in-memory. Acceptable for moderate user
 * counts; see RUNBOOK.md §Known Limitations for scale caveats.
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
import {
  scimToAcmeHrSystemCreate,
  acmeHrSystemToScim,
  scimPatchToAcmeHrSystemPatch,
} from "./mapping.js";

export class AcmeHrSystemUserStore implements UserStore {
  constructor(private readonly client: AcmeHrSystemClient) {}

  // ─── Health probe (Connector Law 8 OBSERVABLE) ──────────────────────────────

  /**
   * Called by skeleton's /healthz route when present on the store.
   * Performs a cheap listUsers to confirm the native API is reachable.
   * Resolves on success, rejects with the underlying error on failure.
   *
   * For production deployments with large user counts, consider replacing
   * listUsers() with a dedicated /ping or HEAD endpoint on the native API
   * to avoid fetching a full user list on every health check.
   */
  async ping(): Promise<void> {
    await this.client.listUsers();
  }

  // ─── UserStore: create ───────────────────────────────────────────────────────

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    const nativeInput = scimToAcmeHrSystemCreate(input);
    try {
      const created = await this.client.createUser(nativeInput);
      return acmeHrSystemToScim(created);
    } catch (err) {
      if (err instanceof AcmeHrSystemApiError && err.status === 409) {
        // Native API returned 409 uid conflict → SCIM uniqueness error.
        // skeleton/routes/users.ts maps UserNameConflictError →
        // 409 + scimType: "uniqueness" per RFC 7644 §3.12 and
        // okta-dialect.md §8.
        throw new UserNameConflictError(nativeInput.uid);
      }
      throw err;
    }
  }

  // ─── UserStore: get ──────────────────────────────────────────────────────────

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user ? acmeHrSystemToScim(user) : null;
  }

  // ─── UserStore: list ─────────────────────────────────────────────────────────

  /**
   * List with optional filter + pagination.
   *
   * okta-dialect.md §2 (filter) + §7 (pagination):
   *   - All users are fetched from the native API (no server-side filter).
   *   - scim2-parse-filter applies the SCIM filter expression in-memory.
   *   - OIN step 16 case-sensitive override: for simple `userName eq <literal>`
   *     patterns, the library's default case-insensitive match is overridden
   *     with an exact-string comparison. See extractSimpleStringEqAttrAndValue().
   *   - startIndex is 1-based; 0 is treated as 1 (okta-dialect.md §7).
   *
   * Note: inactive users (enabled: false) are included in list results when
   * an explicit `active eq false` filter is sent. Unfiltered lists return ALL
   * users including inactive ones — the skeleton routes don't auto-filter by
   * active; Okta's import skips users with active: false anyway per
   * okta-dialect.md §4.
   */
  async list(options: ListOptions): Promise<ListResult> {
    const allNative = await this.client.listUsers();
    const allScim: StoredUser[] = allNative.map(acmeHrSystemToScim);

    let matched = allScim;

    if (options.filter !== undefined && options.filter.trim() !== "") {
      const ast = parse(options.filter);
      const predicate = makePredicate(ast);
      matched = allScim.filter(
        (u) => predicate(u as unknown as Record<string, unknown>),
      );

      // OIN test suite step 16 (Username Case Sensitivity Check):
      // Override scim2-parse-filter's default case-insensitive userName match
      // with a case-exact comparison for simple `userName eq <literal>` filters.
      // okta-dialect.md §2: "OIN test suite step 16 EXPLICITLY tests that
      // filter=userName eq 'SOMEUSER' returns a DIFFERENT result from
      // filter=userName eq 'someuser'".
      const exactOverride = extractSimpleStringEqAttrAndValue(ast);
      if (exactOverride && exactOverride.attr === "userName") {
        matched = matched.filter((u) => u.userName === exactOverride.value);
      }
    }

    const total = matched.length;
    // RFC 7644 §3.4.2.4: startIndex is 1-based. Treat 0 as 1 per okta-dialect.md §7.
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = matched.slice(from, from + options.count);

    return { resources: page, total };
  }

  // ─── UserStore: patch ────────────────────────────────────────────────────────

  /**
   * Apply SCIM PATCH operations to a user.
   *
   * okta-dialect.md §1: Okta emits multi-op PATCHes. We translate ALL ops
   * in document order (RFC 7644 §3.5.2 sequential requirement) into a single
   * merged native patch object, then issue ONE PATCH call to the native API.
   * This is atomic at the SCIM layer: either all ops are reflected in the
   * single API call, or none are (the call fails atomically).
   *
   * Returns null when the target user does not exist (caller maps to 404).
   */
  async patch(
    id: string,
    operations: ScimPatchOperation[],
  ): Promise<StoredUser | null> {
    const nativePatch = scimPatchToAcmeHrSystemPatch(operations);

    // If the translated patch is empty (all ops were unknown/unsupported),
    // do a GET to return the current state rather than issuing a no-op PATCH.
    if (Object.keys(nativePatch).length === 0) {
      return this.get(id);
    }

    const updated = await this.client.patchUser(id, nativePatch);
    return updated ? acmeHrSystemToScim(updated) : null;
  }

  // ─── Soft-delete via DELETE (ticket OKT-10 lifecycle_policy: soft_delete) ───

  /**
   * Called by the SCIM DELETE /Users/:id route.
   *
   * Soft-delete policy (okta-dialect.md §3): Okta does NOT typically emit
   * DELETE — it drives lifecycle via PATCH active: false. However we implement
   * DELETE for edge cases (admin-initiated removal). Soft_delete means we
   * never hard-remove the row; DELETE here is identical in end-state to
   * PATCH active: false.
   *
   * Returns null when the user does not exist. Route layer maps null → 404.
   * Returns the deactivated user on success — route layer returns 204 (no
   * body on DELETE per RFC 7644 §3.6).
   *
   * This method is NOT part of the UserStore interface (the skeleton only
   * requires create/get/list/patch). The users.ts route must call it
   * directly if DELETE support is wired. See server.ts for how the router
   * is extended.
   */
  async softDelete(id: string): Promise<StoredUser | null> {
    const updated = await this.client.deactivateUser(id);
    return updated ? acmeHrSystemToScim(updated) : null;
  }
}

// ─── AST helper (okta-dialect.md §2 case-sensitive override) ─────────────────

/**
 * If the filter AST is a simple top-level `<attr> eq <stringLiteral>`,
 * return attr + value for a case-exact override. Returns null for anything
 * more complex (logical compositions, filter-paths, non-string comparisons).
 *
 * Duplicated from skeleton/store/user-store.ts (intentional — see that file's
 * header comment). Extraction to a shared helper is post-hackathon scope.
 */
function extractSimpleStringEqAttrAndValue(
  ast: unknown,
): { attr: string; value: string } | null {
  if (typeof ast !== "object" || ast === null) return null;
  const node = ast as { op?: unknown; attrPath?: unknown; compValue?: unknown };
  if (node.op !== "eq") return null;
  if (typeof node.attrPath !== "string") return null;
  if (typeof node.compValue !== "string") return null;
  return { attr: node.attrPath, value: node.compValue };
}