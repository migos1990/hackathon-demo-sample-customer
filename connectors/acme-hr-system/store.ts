/**
 * AcmeHrSystemUserStore — adapts the skeleton's UserStore interface to
 * Acme HR System's LDAP-shaped API.
 *
 * Ticket: OKT-10  lifecycle_policy: soft_delete
 *
 * This IS the connector:
 *   SCIM request → skeleton routes → this store → client → target API
 *   response     ← nativeToScim() ← client ← target API
 *
 * Soft-delete semantics (okta-dialect.md §3):
 *   • Okta deactivates via PATCH `active: false` — stored as enabled=false.
 *   • Okta hard-deletes via DELETE /Users/:id — per soft_delete policy the
 *     connector translates this into a PATCH enabled=false on the target,
 *     NOT a DELETE call. The user row is never removed.
 *   • Both paths produce the same end-state: row retained, enabled=false.
 *     okta-dialect.md §3: "DELETE handler and PATCH-active-false handler
 *     MUST be policy-consistent."
 *
 * Filter / pagination (list):
 *   • Acme HR System has no server-side SCIM filter — fetch all, filter
 *     in memory. Acceptable for the customer's scale; if row counts grow
 *     beyond ~10k, push the filter to the target (future ticket).
 *   • Case-sensitive userName override per OIN test suite step 16 and
 *     okta-dialect.md §2. scim2-parse-filter defaults to case-insensitive;
 *     we override for simple `userName eq <literal>` AST nodes.
 *
 * Citations:
 *   okta-dialect.md §1  (PATCH shapes + atomicity)
 *   okta-dialect.md §2  (filter case-sensitivity, OIN step 16)
 *   okta-dialect.md §3  (soft delete semantics)
 *   okta-dialect.md §7  (pagination — startIndex 1-based, treat 0 as 1)
 *   okta-dialect.md §8  (error envelope — 409 uniqueness)
 *   RFC 7644 §3.4.2.4   (pagination response fields)
 *   RFC 7644 §3.5.2     (PATCH atomicity)
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
  scimToNativeCreate,
  nativeToScim,
  scimPatchToNativePatch,
} from "./mapping.js";

export class AcmeHrSystemUserStore implements UserStore {
  constructor(private readonly client: AcmeHrSystemClient) {}

  // -------------------------------------------------------------------------
  // Health probe (Law 8 OBSERVABLE)
  // -------------------------------------------------------------------------

  /**
   * Called by the skeleton's /healthz handler if present. Resolves when
   * the target is reachable; rejects (503) when it is not.
   *
   * listUsers is cheap on the demo target. For production-scale targets
   * replace with a lightweight HEAD/ping endpoint.
   */
  async ping(): Promise<void> {
    await this.client.listUsers();
  }

  // -------------------------------------------------------------------------
  // UserStore interface
  // -------------------------------------------------------------------------

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    const nativeInput = scimToNativeCreate(input);
    try {
      const created = await this.client.createUser(nativeInput);
      return nativeToScim(created);
    } catch (err) {
      if (err instanceof AcmeHrSystemApiError && err.status === 409) {
        // Target returned 409 (uid/userName collision). Translate into the
        // skeleton's typed conflict error so the SCIM route emits
        // 409 + scimType:"uniqueness" per RFC 7644 §3.12 and
        // okta-dialect.md §8.
        throw new UserNameConflictError(nativeInput.uid);
      }
      throw err;
    }
  }

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user ? nativeToScim(user) : null;
  }

  async list(options: ListOptions): Promise<ListResult> {
    // Fetch all users from target; filter in-memory.
    const all = await this.client.listUsers();
    const scimUsers = all.map(nativeToScim);

    let matched = scimUsers;

    if (options.filter !== undefined && options.filter.trim() !== "") {
      const ast = parse(options.filter);
      const predicate = makePredicate(ast);
      matched = scimUsers.filter((u) =>
        predicate(u as unknown as Record<string, unknown>),
      );

      // OIN test suite step 16 (Username Case Sensitivity Check):
      // Okta explicitly tests that `userName eq "FOO"` and
      // `userName eq "foo"` return DIFFERENT results. scim2-parse-filter
      // matches case-insensitively by default (RFC 7643 caseExact=false);
      // we override to case-SENSITIVE for simple `userName eq <literal>`
      // filters. okta-dialect.md §2.
      const override = extractSimpleStringEqAttrAndValue(ast);
      if (override && override.attr === "userName") {
        matched = matched.filter((u) => u.userName === override.value);
      }
    }

    const total = matched.length;

    // RFC 7644 §3.4.2.4 + okta-dialect.md §7: startIndex is 1-based.
    // Treat 0 as 1 (Okta may send either).
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = matched.slice(from, from + options.count);

    return { resources: page, total };
  }

  async patch(
    id: string,
    operations: ScimPatchOperation[],
  ): Promise<StoredUser | null> {
    // Translate SCIM ops → native patch object.
    // RFC 7644 §3.5.2: ops must be applied sequentially (mapping.ts
    // iterates them in order). okta-dialect.md §1.
    const nativePatch = scimPatchToNativePatch(operations);

    const updated = await this.client.patchUser(id, nativePatch);
    return updated ? nativeToScim(updated) : null;
  }

  /**
   * SCIM DELETE handler — soft_delete policy.
   *
   * Ticket OKT-10 `lifecycle_policy: soft_delete` + okta-dialect.md §3:
   * Okta's real deprovisioning signal is PATCH active=false, but if Okta
   * (or an admin) sends DELETE we must still honour the soft-delete policy:
   *   • Flip enabled=false on the target row (PATCH, NOT hard-delete).
   *   • Return the updated user (callers can discard it; included for
   *     consistency with policy-verify tests).
   *
   * If the user does not exist, return null (caller maps to 404).
   *
   * okta-dialect.md §3: "DELETE handler and PATCH-active-false handler
   * MUST be policy-consistent." Both end with the same state: row retained,
   * enabled=false.
   */
  async softDelete(id: string): Promise<StoredUser | null> {
    const nativePatch = { enabled: false };
    const updated = await this.client.patchUser(id, nativePatch);
    return updated ? nativeToScim(updated) : null;
  }
}

// ---------------------------------------------------------------------------
// Private helper — OIN step 16 case-sensitive override
// ---------------------------------------------------------------------------

/**
 * If the AST is a simple top-level `<attr> eq <stringLiteral>`, return the
 * attr + value. Returns null for anything else (logical compositions, nested
 * filters, non-string values). Used to override scim2-parse-filter's
 * case-insensitive default on userName queries.
 *
 * okta-dialect.md §2.
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