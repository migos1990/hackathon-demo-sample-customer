/**
 * AcmeHrSystemUserStore — adapts the skeleton's UserStore interface to
 * Acme HR System's native LDAP-shaped API.
 *
 * This is the connector layer: SCIM in (via skeleton routes), native API
 * out (via client + mapping).
 *
 * Dialect citations (Law 3 DIALECT-CITED):
 *   - Soft-delete policy:       okta-dialect.md §3 ("Okta drives lifecycle
 *                               through `active` flag, NOT DELETE")
 *   - active filtering on LIST: okta-dialect.md §4 ("active:false users
 *                               MUST be hidden from unfiltered GET /Users")
 *   - Case-sensitive userName:  okta-dialect.md §2 + OIN test suite step 16
 *   - Uniqueness → 409:         okta-dialect.md §8, RFC 7644 §3.12
 *   - Pagination:               RFC 7644 §3.4.2.4, okta-dialect.md §7
 *   - PATCH sequential ops:     RFC 7644 §3.5.2
 *
 * Filter + pagination mirrors skeleton/store/user-store.ts with the same
 * OIN step-16 case-sensitive userName override. Code is intentionally
 * duplicated here rather than extracted — the skeleton is a reference;
 * customer connectors own their own copy so a harness upgrade doesn't
 * silently change production connector behaviour.
 *
 * Soft-delete specifics:
 *   - store.create():   creates with enabled=true (or whatever active Okta sent)
 *   - store.patch():    translates SCIM PATCH → native patch (active→enabled)
 *   - store.delete():   calls client.deactivateUser() — sets enabled=false,
 *                       NO row removal (okta-dialect.md §3 lifecycle policy table)
 *   - store.list():     by default excludes active=false users from unfiltered
 *                       results (okta-dialect.md §4). When filter contains
 *                       `active eq false`, users ARE returned (admin view).
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

/**
 * Extended UserStore interface with soft-delete and health-probe support.
 *
 * `delete()` is absent from the base UserStore interface (the skeleton
 * UserStore covers create/get/list/patch). We add it here because:
 *   (a) required_ops.users_delete=true in the ticket.
 *   (b) The skeleton router calls store.delete() if present (duck-typed,
 *       same as store.ping()).
 */
export interface AcmeHrSystemUserStoreInterface extends UserStore {
  /** Soft-delete: set enabled=false on the user. Returns null on 404. */
  delete(id: string): Promise<StoredUser | null>;
  /** Health probe for /healthz (Law 8 OBSERVABLE). */
  ping(): Promise<void>;
}

export class AcmeHrSystemUserStore implements AcmeHrSystemUserStoreInterface {
  constructor(private readonly client: AcmeHrSystemClient) {}

  // ──────────────────────────────────────────────────────────────────────────
  // Health probe
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Cheap reachability check for /healthz (Law 8 OBSERVABLE).
   * Calls listUsers() — if the native API is unreachable this rejects and
   * the health endpoint returns 503.
   */
  async ping(): Promise<void> {
    await this.client.listUsers();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // UserStore implementation
  // ──────────────────────────────────────────────────────────────────────────

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    let nativeInput;
    try {
      nativeInput = scimToAcmeHrSystemCreate(input);
    } catch (err) {
      // Mapping validation failure (missing userName / mail) — re-throw so
      // the route layer can emit a 400. These are not 409s.
      throw err;
    }

    try {
      const created = await this.client.createUser(nativeInput);
      return acmeHrSystemToScim(created);
    } catch (err) {
      if (err instanceof AcmeHrSystemApiError && err.status === 409) {
        // Translate native conflict into skeleton's userName conflict type.
        // SCIM route maps UserNameConflictError → 409 + scimType:uniqueness
        // per RFC 7644 §3.12 and okta-dialect.md §8.
        throw new UserNameConflictError(nativeInput.uid);
      }
      throw err;
    }
  }

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user ? acmeHrSystemToScim(user) : null;
  }

  /**
   * List users with filter + pagination.
   *
   * Filter is evaluated client-side (Acme HR System has no server-side
   * SCIM filter API). Fetches all enabled users first, then applies the
   * filter predicate.
   *
   * active=false filtering (okta-dialect.md §4):
   *   - Unfiltered LIST:           only active=true users returned.
   *   - filter contains `active eq false`: active=false users included.
   *   - filter contains `active eq true`:  only active=true (redundant but correct).
   *   This matches Okta's documented import behaviour: "Okta doesn't pull in
   *   a user whose status is set to `active=false`, even in a full import."
   */
  async list(options: ListOptions): Promise<ListResult> {
    // Fetch all native users. Filter pushdown is a future optimisation;
    // current Acme HR System API has no filter query param.
    const allNative = await this.client.listUsers();
    let allScim = allNative.map(acmeHrSystemToScim);

    // Determine if caller is explicitly asking for inactive users.
    const filterStr = options.filter?.trim() ?? "";
    const callerWantsInactive = filterStr !== "" && /active\s+eq\s+["']?false["']?/i.test(filterStr);
    const callerWantsActive = filterStr !== "" && /active\s+eq\s+["']?true["']?/i.test(filterStr);

    // Default: hide inactive users (okta-dialect.md §4).
    // If the filter explicitly asks for active=false, include them.
    if (!callerWantsInactive) {
      allScim = allScim.filter((u) => u.active !== false);
    }

    // Apply SCIM filter predicate using scim2-parse-filter.
    let matched = allScim;
    if (filterStr !== "") {
      let ast: unknown;
      try {
        ast = parse(filterStr);
      } catch (err) {
        // Malformed filter — propagate so the route layer emits 400+invalidFilter.
        throw err;
      }
      const predicate = makePredicate(ast as Parameters<typeof makePredicate>[0]);
      matched = allScim.filter((u) =>
        predicate(u as unknown as Record<string, unknown>),
      );

      // OIN test suite step 16 (Username Case Sensitivity Check):
      // scim2-parse-filter defaults to case-INSENSITIVE for userName (RFC 7643
      // caseExact=false). Okta's OIN test explicitly asserts case-SENSITIVE.
      // Override: for simple `userName eq <literal>` filters, re-filter to
      // exact string match. See okta-dialect.md §2.
      const caseOverride = extractSimpleStringEqAttrAndValue(ast);
      if (caseOverride && caseOverride.attr === "userName") {
        matched = matched.filter((u) => u.userName === caseOverride.value);
      }

      // active eq true/false filters: scim2-parse-filter should handle these
      // correctly since active is a boolean. The regex pre-filter above already
      // gates which rows we pass to the predicate. Explicit active=true filter
      // is a no-op here (we already excluded inactive), but correct for parity.
      void callerWantsActive; // referenced above; void suppresses lint.
    }

    const total = matched.length;
    // RFC 7644 §3.4.2.4: 1-based startIndex. Treat 0 as 1 (okta-dialect.md §7).
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = matched.slice(from, from + options.count);

    return { resources: page, total };
  }

  async patch(
    id: string,
    operations: ScimPatchOperation[],
  ): Promise<StoredUser | null> {
    // Translate SCIM ops → native patch body.
    // Sequential application is handled by scimPatchToAcmeHrSystemPatch
    // iterating ops in order (RFC 7644 §3.5.2).
    const nativePatch = scimPatchToAcmeHrSystemPatch(operations);

    // If the patch is empty (all ops mapped to no-ops), still call the
    // target so we get a fresh copy of the user to return. A no-op PATCH
    // returning the current user is valid SCIM behaviour.
    const updated = await this.client.patchUser(id, nativePatch);
    return updated ? acmeHrSystemToScim(updated) : null;
  }

  /**
   * Soft-delete — SCIM DELETE /Users/:id handler.
   *
   * Per ticket lifecycle_policy: "soft_delete" and okta-dialect.md §3:
   * Okta rarely issues DELETE directly; deprovisioning goes via PATCH
   * active=false. BUT required_ops.users_delete=true in the ticket means
   * the SCIM DELETE endpoint must exist. Under soft-delete policy both
   * paths produce identical outcomes: enabled=false, row retained.
   *
   * Returns null when user not found (store returns null → route emits 404).
   * Returns the updated user (now active=false) on success — the route
   * skeleton emits 204 on DELETE, but we return the user for auditability
   * and potential future use.
   */
  async delete(id: string): Promise<StoredUser | null> {
    const updated = await this.client.deactivateUser(id);
    return updated ? acmeHrSystemToScim(updated) : null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * If the AST is a top-level `<attr> eq <stringLiteral>`, return attr + value.
 * Used for the OIN step 16 case-sensitive userName override.
 * Duplicated from skeleton/store/user-store.ts — see header comment.
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