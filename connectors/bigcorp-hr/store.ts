/**
 * BigCorpHrUserStore — adapts the skeleton's UserStore interface to
 * BigCorpHR's LDAP-shaped API via client.ts + mapping.ts.
 *
 * This IS the connector boundary: SCIM in (via skeleton routes), BigCorpHR
 * out (via client + mapping).
 *
 * Key decisions:
 *
 * 1. soft_delete policy (ticket OKT-7, okta-dialect.md §3):
 *    Okta's deprovisioning signal is PATCH active=false, NOT DELETE.
 *    When the skeleton routes call store.patch() with active=false, we
 *    translate that to BigCorpHR PATCH {enabled: false} — row is retained.
 *    The store also exposes a deleteUser() method (called by the SCIM
 *    DELETE /Users/:id route) which, under soft_delete, likewise resolves
 *    to {enabled: false}.  No row is ever hard-deleted.
 *    okta-dialect.md §3: "Okta does NOT use DELETE /Users/{id} at all in
 *    the standard lifecycle."
 *
 * 2. Filter + pagination (okta-dialect.md §7, RFC 7644 §3.4.2.4):
 *    BigCorpHR has no server-side filter API → fetch all, filter in-memory.
 *    OIN step 16 case-sensitive override for userName eq applied per
 *    okta-dialect.md §2.
 *
 * 3. userName uniqueness (okta-dialect.md §8):
 *    BigCorpHR returns 409 on uid collision → rethrown as
 *    UserNameConflictError → skeleton maps to 409 + scimType:uniqueness.
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
import type { BigCorpHrClient } from "./client.js";
import { BigCorpHrApiError } from "./client.js";
import {
  scimToBigCorpHrCreate,
  bigCorpHrToScim,
  scimPatchToBigCorpHrPatch,
} from "./mapping.js";

export class BigCorpHrUserStore implements UserStore {
  constructor(private readonly client: BigCorpHrClient) {}

  // -------------------------------------------------------------------------
  // Healthz probe (Connector Law 8 OBSERVABLE)
  // -------------------------------------------------------------------------

  /**
   * Target-reachability probe for /healthz.  Calls listUsers() — cheap on
   * BigCorpHR-like APIs.  The skeleton's healthzRouter duck-types for this
   * method and calls it if present.
   */
  async ping(): Promise<void> {
    await this.client.listUsers();
  }

  // -------------------------------------------------------------------------
  // UserStore interface
  // -------------------------------------------------------------------------

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    const nativeInput = scimToBigCorpHrCreate(input);
    try {
      const created = await this.client.createUser(nativeInput);
      return bigCorpHrToScim(created);
    } catch (err) {
      if (err instanceof BigCorpHrApiError && err.status === 409) {
        // BigCorpHR uid collision → SCIM 409 + scimType:uniqueness.
        // okta-dialect.md §8 + RFC 7644 §3.12.
        throw new UserNameConflictError(nativeInput.uid);
      }
      throw err;
    }
  }

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user ? bigCorpHrToScim(user) : null;
  }

  async list(options: ListOptions): Promise<ListResult> {
    // Fetch all, filter in-memory — BigCorpHR has no server-side filter API.
    // For large directories (>10k users) consider adding server-side filter
    // support to BigCorpHR; see RUNBOOK.md §Known limitations.
    const all = await this.client.listUsers();
    const scimUsers = all.map(bigCorpHrToScim);

    let matched = scimUsers;
    if (options.filter !== undefined && options.filter.trim() !== "") {
      const ast = parse(options.filter);
      const predicate = makePredicate(ast);
      matched = scimUsers.filter((u) =>
        predicate(u as unknown as Record<string, unknown>),
      );

      // OIN test suite step 16 (Username Case Sensitivity Check):
      // `filter=userName eq "FOO"` must return a DIFFERENT result from
      // `filter=userName eq "foo"`.  scim2-parse-filter defaults to
      // case-insensitive matching (RFC 7643 caseExact=false for userName).
      // Override to case-SENSITIVE for simple `userName eq <literal>` filters.
      // okta-dialect.md §2 "Case sensitivity — THE Okta quirk".
      const override = extractSimpleStringEqAttrAndValue(ast);
      if (override && override.attr === "userName") {
        matched = matched.filter((u) => u.userName === override.value);
      }
    }

    const total = matched.length;
    // RFC 7644 §3.4.2.4: startIndex is 1-based.  Treat 0 as 1 per
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
    const nativePatch = scimPatchToBigCorpHrPatch(operations);
    const updated = await this.client.patchUser(id, nativePatch);
    return updated ? bigCorpHrToScim(updated) : null;
  }

  // -------------------------------------------------------------------------
  // Soft-delete (lifecycle_policy: soft_delete)
  // -------------------------------------------------------------------------

  /**
   * Called by the SCIM DELETE /Users/:id route (skeleton routes/users.ts
   * will need to be extended to call this — see server.ts for the wiring).
   *
   * lifecycle_policy: soft_delete — we do NOT issue a DELETE to BigCorpHR.
   * Instead we PATCH {enabled: false}, keeping the row for compliance audit.
   *
   * okta-dialect.md §3: "Okta does NOT use DELETE /Users/{id} at all in the
   * standard lifecycle.  DELETE may be implemented for edge cases (admin-
   * initiated forced removal)."  Per the same section, the DELETE and
   * PATCH-active-false handlers MUST be policy-consistent.
   *
   * Returns null if the user does not exist (404 from target).
   */
  async deleteUser(id: string): Promise<StoredUser | null> {
    // Soft-delete = deactivate.  Same outcome as PATCH active:false.
    const updated = await this.client.patchUser(id, { enabled: false });
    return updated ? bigCorpHrToScim(updated) : null;
  }
}

// ---------------------------------------------------------------------------
// AST helper — OIN step 16 case-sensitive userName override
// ---------------------------------------------------------------------------

/**
 * If the AST is a simple top-level `<attr> eq <stringLiteral>`, return the
 * attr name and literal value so the caller can apply case-exact matching.
 * Returns null for anything more complex (logical compositions, filter-paths,
 * non-string comparisons).
 *
 * This override is required for OIN acceptance.
 * okta-dialect.md §2 "Case sensitivity — THE Okta quirk".
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