/**
 * AcmeHrSystemUserStore — adapts the skeleton's UserStore interface to
 * Acme HR System's native LDAP-shaped API.
 *
 * This IS the connector: SCIM in (via skeleton routes), Acme HR System
 * out (via client + mapping).
 *
 * Flow:
 *   1. SCIM request → skeleton routes (skeleton/routes/users.ts)
 *   2. Skeleton calls store.create / get / list / patch / delete
 *   3. Store invokes mapping.ts to translate payloads
 *   4. Store invokes client.ts to hit Acme HR System's API
 *   5. Response translates native → SCIM on the way back
 *
 * Lifecycle policy: soft_delete (OKT-10 ticket).
 * Both delete() and PATCH active:false result in {enabled:false} at the
 * target — same end-state, same policy — per okta-dialect.md §3.
 *
 * Filter + pagination mirrors skeleton/store/user-store.ts including the
 * OIN step 16 case-sensitive override for `userName eq <literal>`.
 * Code is duplicated intentionally — post-hackathon refactor scope.
 * okta-dialect.md §2.
 *
 * Ticket: OKT-10
 */

import { parse, filter as makePredicate } from "scim2-parse-filter";
import type { ScimPatchOperation } from "scim-patch";
import {
  UserNameConflictError,
  type UserStore,
  type ListOptions,
  type ListResult,
} from "../../skeleton/store/user-store.js";
import type { ScimUser, StoredUser } from "../../skeleton/types.js";
import type { AcmeHrSystemClient } from "./client.js";
import { AcmeHrSystemApiError } from "./client.js";
import {
  scimToAcmeHrSystemCreate,
  acmeHrSystemToScim,
  scimPatchToAcmeHrSystemPatch,
} from "./mapping.js";

/**
 * Extend UserStore with delete() to support HTTP DELETE /Users/{id}.
 *
 * The skeleton UserStore interface does not include delete() because RFC 7644
 * makes DELETE optional and Okta's primary lifecycle path is PATCH active:false
 * (okta-dialect.md §3). OKT-10 requires users_delete:true, so we extend here
 * and the users router in server.ts handles the DELETE method explicitly.
 */
export interface UserStoreWithDelete extends UserStore {
  delete(id: string): Promise<boolean>;
}

export class AcmeHrSystemUserStore implements UserStoreWithDelete {
  constructor(private readonly client: AcmeHrSystemClient) {}

  /**
   * Liveness + target-reachability probe for /healthz.
   * Connector Law 8 OBSERVABLE. The healthzRouter in the skeleton calls
   * ping() when present. Uses listUsers() — cheap for Acme HR System;
   * generated connectors for expensive-list targets should use a dedicated
   * HEAD/ping endpoint instead.
   */
  async ping(): Promise<void> {
    await this.client.listUsers();
  }

  // -------------------------------------------------------------------------
  // UserStore implementation
  // -------------------------------------------------------------------------

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    const nativeInput = scimToAcmeHrSystemCreate(input);
    try {
      const created = await this.client.createUser(nativeInput);
      return acmeHrSystemToScim(created);
    } catch (err) {
      if (err instanceof AcmeHrSystemApiError && err.status === 409) {
        // Translate target 409 → skeleton's UserNameConflictError.
        // SCIM route maps to 409 + scimType:uniqueness per RFC 7644 §3.12
        // and okta-dialect.md §8. OIN test suite step 14.
        throw new UserNameConflictError(nativeInput.uid);
      }
      throw err;
    }
  }

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user !== null ? acmeHrSystemToScim(user) : null;
  }

  /**
   * List with in-memory filter + pagination.
   *
   * Acme HR System has no server-side filter API — fetch all, filter
   * in-memory. Workable for small-to-medium directories. See RUNBOOK.md
   * Known Limitations for the scale caveat.
   *
   * Pagination: RFC 7644 §3.4.2.4 1-based startIndex.
   * okta-dialect.md §7: Okta sends count:100 / startIndex:1 by default.
   *
   * OIN test suite step 16 case-sensitive userName override applied here.
   * okta-dialect.md §2 — scim2-parse-filter is case-insensitive by default;
   * we override for simple `userName eq <literal>` patterns.
   */
  async list(options: ListOptions): Promise<ListResult> {
    const all = await this.client.listUsers();
    const scimUsers = all.map(acmeHrSystemToScim);

    let matched = scimUsers;

    if (options.filter !== undefined && options.filter.trim() !== "") {
      const ast = parse(options.filter);
      const predicate = makePredicate(ast);
      matched = scimUsers.filter(
        (u) => predicate(u as unknown as Record<string, unknown>),
      );

      // OIN step 16 — case-sensitive override for simple `userName eq <literal>`.
      // Okta explicitly asserts case-sensitive matching. okta-dialect.md §2.
      const override = extractSimpleStringEqAttrAndValue(ast);
      if (override !== null && override.attr === "userName") {
        matched = matched.filter((u) => u.userName === override.value);
      }
    }

    const total = matched.length;
    // Treat startIndex:0 as 1 per okta-dialect.md §7.
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = matched.slice(from, from + options.count);

    return { resources: page, total };
  }

  /**
   * PATCH — translates SCIM ops → native patch, then applies.
   *
   * okta-dialect.md §1: ops applied sequentially, not in parallel.
   * That contract lives in scimPatchToAcmeHrSystemPatch (mapping.ts)
   * which iterates the ops array in order.
   *
   * Returns null when id is not found → SCIM route returns 404.
   * Returns 200 + updated body on success per okta-dialect.md §1
   * "Status 204 on PATCH" anti-pattern.
   */
  async patch(
    id: string,
    operations: ScimPatchOperation[],
  ): Promise<StoredUser | null> {
    const nativePatch = scimPatchToAcmeHrSystemPatch(operations);
    const updated = await this.client.patchUser(id, nativePatch);
    return updated !== null ? acmeHrSystemToScim(updated) : null;
  }

  /**
   * DELETE — soft-delete per lifecycle_policy=soft_delete.
   *
   * Sets enabled=false at the target. Row is NEVER physically removed.
   * Idempotent: deleting an already-deactivated user returns true (success).
   * Deleting a non-existent user returns false (caller returns 404).
   *
   * okta-dialect.md §3: "DELETE and PATCH-active-false handler MUST be
   * policy-consistent." Both paths set enabled=false here.
   *
   * Returns true on success (including idempotent re-delete), false on 404.
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.client.deleteUser(id);
    return result !== null;
  }
}

/**
 * AST walker — if the top-level expression is `<attr> eq <stringLiteral>`,
 * extract attr + value; otherwise return null.
 *
 * Used for the OIN step 16 case-sensitive override on simple userName queries.
 * okta-dialect.md §2 "Case sensitivity — THE Okta quirk".
 *
 * Duplicated from skeleton/store/user-store.ts — see store.ts header comment.
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