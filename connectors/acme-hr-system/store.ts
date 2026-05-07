/**
 * AcmeHrSystemUserStore — adapts skeleton's UserStore interface to the
 * Acme HR System native API via client.ts + mapping.ts.
 *
 * This is the connector's central seam: SCIM in (skeleton routes) →
 * mapping → native API (client) → mapping back → SCIM out.
 *
 * Key behavioral decisions (all citeable):
 *
 *   Soft-delete (lifecycle_policy: "soft_delete" — OKT-10):
 *     SCIM DELETE /Users/:id → PATCH {enabled:false} on target (NOT a
 *     hard delete). Okta's primary deprovisioning signal is PATCH
 *     active:false anyway (okta-dialect.md §3); DELETE is a secondary
 *     path that must produce the same end state under soft_delete.
 *
 *   active:false filter suppression (okta-dialect.md §4):
 *     Deactivated users are hidden from unfiltered GET /Users lists.
 *     `active eq false` filter is supported for admin views.
 *
 *   OIN step 16 case-sensitive userName filter override:
 *     scim2-parse-filter defaults to case-insensitive matching per
 *     RFC 7643 (caseExact=false). OIN test suite step 16 explicitly
 *     asserts case-SENSITIVE match. Override applied inline on simple
 *     `userName eq <literal>` ASTs. okta-dialect.md §2.
 *
 *   Filter on all users in memory:
 *     Acme HR System has no server-side SCIM filter. We fetch all users
 *     and filter locally. Acceptable for typical enterprise user counts
 *     (<10k). Customers with larger populations should push filters to
 *     the target API — note in RUNBOOK.md known-limitations.
 *
 *   409 translation:
 *     AcmeHrSystemApiError(409) from createUser → UserNameConflictError
 *     → SCIM 409 + scimType:uniqueness per RFC 7644 §3.12 and
 *     okta-dialect.md §8.
 *
 * Citations:
 *   - okta-dialect.md §1 (PATCH shapes)
 *   - okta-dialect.md §2 (filter, case sensitivity)
 *   - okta-dialect.md §3 (soft delete)
 *   - okta-dialect.md §4 (active attribute)
 *   - okta-dialect.md §7 (pagination)
 *   - okta-dialect.md §8 (error envelope)
 *   - RFC 7644 §3.4.2.4 (pagination)
 *   - RFC 7644 §3.5.2 (PATCH atomicity)
 *   - RFC 7644 §3.12 (error response)
 */
import { parse, filter as makePredicate } from "scim2-parse-filter";
import type { ScimPatchOperation } from "scim-patch";
import type { UserStore, ListOptions, ListResult } from "../../skeleton/store/user-store.js";
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

  /**
   * Liveness + target-reachability probe for GET /scim/v2/healthz.
   * Connector Law 8 OBSERVABLE. Called by skeleton/routes/healthz.ts when
   * the store exposes a `ping` method.
   */
  async ping(): Promise<void> {
    await this.client.ping();
  }

  // ─── UserStore interface ─────────────────────────────────────────────────

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    const nativeInput = scimToAcmeHrSystemCreate(input);
    try {
      const created = await this.client.createUser(nativeInput);
      return acmeHrSystemToScim(created);
    } catch (err) {
      if (err instanceof AcmeHrSystemApiError && err.status === 409) {
        // okta-dialect.md §8: 409 → scimType:uniqueness is how Okta
        // detects "user already exists, skip create".
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
   * Soft-delete: Okta sends DELETE /Users/:id in edge cases
   * (okta-dialect.md §3 — primary signal is PATCH active:false, but
   * DELETE can arrive from admin-initiated forced removal).
   * Under soft_delete policy, both paths produce the same end-state:
   * the user record is retained with enabled:false.
   *
   * Returns 204 by convention (the SCIM route in skeleton/routes/users.ts
   * sends 204 for DELETE). If the user is not found, the route maps
   * null → 404. okta-dialect.md §3.
   */
  async delete(id: string): Promise<boolean> {
    // Soft-delete: PATCH enabled:false rather than hard DELETE.
    // This is consistent with lifecycle_policy: "soft_delete" (OKT-10)
    // and Okta's primary deactivation path. okta-dialect.md §3.
    const updated = await this.client.patchUser(id, { enabled: false });
    return updated !== null;
  }

  async list(options: ListOptions): Promise<ListResult> {
    // Fetch all, filter in memory — see header comment on filter pushdown.
    const all = await this.client.listUsers();
    const scimUsers = all.map(acmeHrSystemToScim);

    // okta-dialect.md §4: deactivated users hidden from unfiltered lists.
    // When no filter is present, return only active users.
    let matched: StoredUser[];
    if (!options.filter || options.filter.trim() === "") {
      matched = scimUsers.filter((u) => u.active !== false);
    } else {
      matched = applyScimFilter(scimUsers, options.filter);
    }

    const total = matched.length;
    // RFC 7644 §3.4.2.4: startIndex is 1-based. Treat 0 as 1 per
    // okta-dialect.md §7.
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = matched.slice(from, from + options.count);

    return { resources: page, total };
  }

  async patch(
    id: string,
    operations: ScimPatchOperation[],
  ): Promise<StoredUser | null> {
    const nativePatch = scimPatchToAcmeHrSystemPatch(operations);

    // If the patch is entirely no-op (no fields translated), we still
    // issue the native PATCH so the target's lastModified is updated and
    // Okta's round-trip read gets a fresh body. Some targets return 200
    // with the unchanged resource; others may return 304 — we normalise
    // to StoredUser | null either way.
    const updated = await this.client.patchUser(id, nativePatch);
    return updated ? acmeHrSystemToScim(updated) : null;
  }
}

// ─── Filter helpers ──────────────────────────────────────────────────────────

/**
 * Apply a SCIM filter expression to an in-memory array of SCIM users.
 *
 * Applies the scim2-parse-filter predicate first, then overrides
 * case-sensitivity for simple `userName eq <literal>` expressions to
 * satisfy OIN test suite step 16 (okta-dialect.md §2 — case-sensitive
 * userName matching by default).
 *
 * Throws if the filter string is syntactically invalid so the route can
 * map it to 400 + scimType:invalidFilter (RFC 7644 §3.12).
 */
function applyScimFilter(
  users: StoredUser[],
  filterStr: string,
): StoredUser[] {
  const ast = parse(filterStr); // throws on syntax error
  const predicate = makePredicate(ast);
  let matched = users.filter((u) =>
    predicate(u as unknown as Record<string, unknown>),
  );

  // OIN step 16 case-sensitive override for `userName eq <literal>`.
  // scim2-parse-filter matches case-insensitively by default (RFC 7643
  // caseExact=false). Okta's spec test asserts case-SENSITIVE semantics.
  // okta-dialect.md §2.
  const eqOverride = extractSimpleStringEq(ast);
  if (eqOverride && eqOverride.attr === "userName") {
    matched = matched.filter((u) => u.userName === eqOverride.value);
  }

  return matched;
}

/**
 * If `ast` is a simple top-level `<attr> eq <stringLiteral>`, return
 * {attr, value}. Returns null for anything more complex. Used solely
 * for the OIN step 16 case-exact override. okta-dialect.md §2.
 */
function extractSimpleStringEq(
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