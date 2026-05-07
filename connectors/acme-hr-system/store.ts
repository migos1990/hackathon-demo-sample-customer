/**
 * AcmeHrSystemUserStore — UserStore implementation that adapts the
 * skeleton's SCIM-facing interface to the Acme HR System's native API.
 *
 * This is the connector's central seam:
 *   SCIM request (skeleton routes)
 *     → store (this file)
 *       → mapping.ts (payload translation)
 *       → client.ts (HTTP to Acme HR System)
 *     ← mapping.ts (response translation)
 *   ← SCIM response
 *
 * Behavioral contracts:
 *
 *   SOFT-DELETE POLICY (ticket lifecycle_policy=soft_delete):
 *     Okta deprovisions via PATCH active=false (okta-dialect.md §3).
 *     Okta may also send DELETE /Users/:id (ticket required_ops.users_delete=true).
 *     Per soft_delete policy BOTH paths translate to {enabled:false} on the
 *     native API — we never call client.deleteUser(). The physical row is
 *     retained for audit. okta-dialect.md §3 table (soft_delete row).
 *
 *   FILTER + PAGINATION:
 *     The Acme HR System API has no server-side SCIM filter support — we
 *     fetch all users and filter in-memory (same strategy as the reference
 *     connector connectors/acme-hr/store.ts).
 *     OIN step 16 (case-sensitive userName) override is applied here per
 *     okta-dialect.md §2 — scim2-parse-filter matches case-insensitively
 *     by default; we patch that for simple `userName eq <literal>` filters.
 *
 *   CONFLICT HANDLING:
 *     client.createUser returning 409 is translated to UserNameConflictError
 *     which the SCIM route maps to 409 + scimType:uniqueness per RFC 7644
 *     §3.12 and okta-dialect.md §8.
 *
 *   HEALTH PROBE:
 *     ping() calls client.listUsers() — the cheapest available probe.
 *     Connector Law 8 (OBSERVABLE): healthz router duck-types this method.
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

  // --------------------------------------------------------------------------
  // Health probe — Connector Law 8 (OBSERVABLE)
  // --------------------------------------------------------------------------

  /**
   * Cheap reachability check. The skeleton's healthzRouter calls this when
   * present. Any successful response from the Acme HR System API counts as
   * healthy — we don't inspect the payload.
   */
  async ping(): Promise<void> {
    await this.client.listUsers();
  }

  // --------------------------------------------------------------------------
  // create — POST /Users
  // --------------------------------------------------------------------------

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    const nativeInput = scimToAcmeHrSystemCreate(input);
    try {
      const created = await this.client.createUser(nativeInput);
      return acmeHrSystemToScim(created);
    } catch (err) {
      if (err instanceof AcmeHrSystemApiError && err.status === 409) {
        // Translate native uid collision → SCIM-layer uniqueness error.
        // SCIM route: 409 + scimType:uniqueness per RFC 7644 §3.12.
        // okta-dialect.md §8.
        throw new UserNameConflictError(nativeInput.uid);
      }
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // get — GET /Users/:id
  // --------------------------------------------------------------------------

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user ? acmeHrSystemToScim(user) : null;
  }

  // --------------------------------------------------------------------------
  // list — GET /Users (with optional filter + pagination)
  // --------------------------------------------------------------------------

  /**
   * Fetch all users from the native API and apply SCIM filter + pagination
   * in-process. okta-dialect.md §7 (pagination), §2 (filter + case-sensitivity).
   *
   * In-memory filtering is the pragmatic path for apps with no server-side
   * SCIM filter API. For Acme HR System instances with > ~5 000 users, a
   * filter-pushdown optimisation should be added (see RUNBOOK.md §Limitations).
   */
  async list(options: ListOptions): Promise<ListResult> {
    const all = await this.client.listUsers();
    const scimUsers = all.map(acmeHrSystemToScim);

    let matched = scimUsers;

    if (options.filter !== undefined && options.filter.trim() !== "") {
      const ast = parse(options.filter);
      const predicate = makePredicate(ast);
      matched = scimUsers.filter((u) =>
        predicate(u as unknown as Record<string, unknown>),
      );

      // OIN test suite step 16 (Username Case Sensitivity Check):
      // scim2-parse-filter uses RFC 7643's caseExact=false default for
      // userName and matches case-insensitively. Okta's test explicitly
      // expects `userName eq "FOO"` to return a DIFFERENT result than
      // `userName eq "foo"`, so we override to case-EXACT for the simple
      // `userName eq <literal>` shape.
      // okta-dialect.md §2 — case sensitivity quirk.
      const caseExact = extractSimpleStringEqAttrAndValue(ast);
      if (caseExact && caseExact.attr === "userName") {
        matched = matched.filter((u) => u.userName === caseExact.value);
      }
    }

    const total = matched.length;
    // RFC 7644 §3.4.2.4: startIndex is 1-based.
    // okta-dialect.md §7: treat 0 as 1.
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = matched.slice(from, from + options.count);

    return { resources: page, total };
  }

  // --------------------------------------------------------------------------
  // patch — PATCH /Users/:id
  // --------------------------------------------------------------------------

  /**
   * Apply SCIM PATCH operations. Translates to a native partial-update.
   *
   * Returns null when the user does not exist (SCIM route maps to 404).
   *
   * Multi-op PATCH: all ops are translated together into a single native
   * patch object, then sent in one request. If the native API returns an
   * error the whole PATCH fails atomically — no partial state is committed
   * (assuming the native API is also atomic on its own PATCH).
   * RFC 7644 §3.5.2 — atomicity requirement. okta-dialect.md §1.
   */
  async patch(
    id: string,
    operations: ScimPatchOperation[],
  ): Promise<StoredUser | null> {
    const nativePatch = scimPatchToAcmeHrSystemPatch(operations);

    // If translation produced an empty patch (all ops were no-ops / unknown
    // paths), we still need to return the current user state — not null.
    // An empty PATCH is valid and idempotent per RFC 7644 §3.5.2.
    if (Object.keys(nativePatch).length === 0) {
      return this.get(id);
    }

    const updated = await this.client.patchUser(id, nativePatch);
    return updated ? acmeHrSystemToScim(updated) : null;
  }

  // --------------------------------------------------------------------------
  // delete — DELETE /Users/:id  (SOFT-DELETE policy)
  // --------------------------------------------------------------------------

  /**
   * Okta sends DELETE when an admin removes a user from the app assignment
   * (ticket required_ops.users_delete=true).
   *
   * SOFT-DELETE POLICY: we translate DELETE into a deactivation PATCH
   * ({enabled:false}) rather than calling client.deleteUser().
   * The physical row is NEVER removed — retention requirement.
   * okta-dialect.md §3 table (soft_delete row).
   *
   * This method is NOT part of the UserStore interface (which is the minimum
   * Okta SCIM surface), but it is wired into the HTTP router below via a
   * type assertion. The skeleton's usersRouter does not yet expose DELETE;
   * the connector registers its own DELETE handler in server.ts.
   */
  async softDelete(id: string): Promise<StoredUser | null> {
    // Reuse the patch path — same outcome, same audit trail.
    const updated = await this.client.patchUser(id, { enabled: false });
    return updated ? acmeHrSystemToScim(updated) : null;
  }
}

// ---------------------------------------------------------------------------
// Shared helper — OIN step 16 case-sensitivity override
// ---------------------------------------------------------------------------

/**
 * If the SCIM filter AST root is a simple `<attr> eq <stringLiteral>`,
 * return `{attr, value}` for a case-exact override.
 * Returns null for compound filters, non-string comparisons, etc.
 *
 * Duplicated from skeleton/store/user-store.ts — see that file's comment
 * for the rationale. Post-hackathon: extract to a shared util.
 * okta-dialect.md §2.
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