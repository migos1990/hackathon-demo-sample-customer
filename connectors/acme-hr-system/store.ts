/**
 * AcmeHrSystemUserStore — adapts the skeleton's UserStore interface to the
 * Acme HR System native API (OKT-10).
 *
 * This is the connector's core integration layer:
 *   SCIM route (skeleton) → this store → mapping.ts → client.ts → customer API
 *
 * Behavioral guarantees (all tested in store.test.ts):
 *   - list() fetches all users from the target and filters in-memory.
 *     AcmeHR System has no server-side SCIM filter support. See RUNBOOK.md
 *     §Known Limitations for the performance implication at scale.
 *   - Case-sensitive `userName eq <literal>` override for OIN test suite
 *     step 16 (okta-dialect.md §2). scim2-parse-filter defaults to
 *     case-insensitive; we override for the simple `eq` case.
 *   - create() maps AcmeHrSystemApiError(409) → UserNameConflictError so
 *     the skeleton route returns 409 + scimType:uniqueness (okta-dialect.md §8,
 *     RFC 7644 §3.12, OIN test suite step 14).
 *   - patch() returns null on 404 so the skeleton route returns SCIM 404.
 *     Per okta-dialect.md §1, PATCH must return 200 + full body on success —
 *     the skeleton handles that; this store just returns the StoredUser.
 *   - delete() is a SOFT DELETE per OKT-10 lifecycle_policy=soft_delete
 *     (okta-dialect.md §3). The row is never removed; enabled is set to false.
 *     Both the SCIM DELETE and SCIM PATCH active:false paths yield the same
 *     end-state per the policy.
 *   - ping() exercises a cheap listUsers() call for /healthz liveness probes
 *     (Connector Law 8 OBSERVABLE).
 *
 * Citations:
 *   - okta-dialect.md §1 (PATCH 200 + body)
 *   - okta-dialect.md §2 (case-sensitive userName eq filter — OIN step 16)
 *   - okta-dialect.md §3 (soft-delete policy)
 *   - okta-dialect.md §7 (pagination — 1-based startIndex)
 *   - okta-dialect.md §8 (409 uniqueness)
 *   - RFC 7644 §3.4.2.4 (pagination fields)
 *   - RFC 7644 §3.5.2 (PATCH atomicity)
 *   - RFC 7644 §3.6 (DELETE)
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
 * Extended UserStore interface that adds soft-delete and a health probe.
 * The skeleton's DELETE route checks for a `softDelete` method on the
 * injected store; the healthz router checks for `ping`.
 */
export interface AcmeHrSystemUserStoreInterface extends UserStore {
  softDelete(id: string): Promise<StoredUser | null>;
  ping(): Promise<void>;
}

export class AcmeHrSystemUserStore implements AcmeHrSystemUserStoreInterface {
  constructor(private readonly client: AcmeHrSystemClient) {}

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
        // Target returned 409 (uid already exists). Surface as
        // UserNameConflictError so the skeleton route emits
        // 409 + scimType:uniqueness per okta-dialect.md §8.
        throw new UserNameConflictError(nativeInput.uid);
      }
      throw err;
    }
  }

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user ? acmeHrSystemToScim(user) : null;
  }

  async list(options: ListOptions): Promise<ListResult> {
    // Fetch all users from the target then filter + paginate in memory.
    // AcmeHR System has no server-side SCIM filter API. See RUNBOOK.md §Known
    // Limitations for the >10k user scale warning.
    const allNative = await this.client.listUsers();
    const allScim: StoredUser[] = allNative.map(acmeHrSystemToScim);

    let matched = allScim;

    if (options.filter !== undefined && options.filter.trim() !== "") {
      const ast = parse(options.filter);
      const predicate = makePredicate(ast);
      matched = allScim.filter((u) =>
        predicate(u as unknown as Record<string, unknown>),
      );

      // OIN test suite step 16 — Username Case Sensitivity Check.
      // scim2-parse-filter defaults to case-insensitive matching for userName
      // (RFC 7643 caseExact=false default). Okta's spec test EXPLICITLY asserts
      // case-sensitive behavior. Override for the simple `userName eq <literal>`
      // shape. See okta-dialect.md §2.
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

  async patch(
    id: string,
    operations: ScimPatchOperation[],
  ): Promise<StoredUser | null> {
    // Translate SCIM patch ops → native patch shape.
    // scimPatchToAcmeHrSystemPatch handles all four Okta-emitted shapes
    // (okta-dialect.md §1) and applies them sequentially (RFC 7644 §3.5.2).
    const nativePatch = scimPatchToAcmeHrSystemPatch(operations);

    // If no fields resolved from the ops (all unknown paths), still send
    // the patch so the caller gets back the current server state rather
    // than null (which would be misread as 404).
    const updated = await this.client.patchUser(id, nativePatch);
    return updated ? acmeHrSystemToScim(updated) : null;
  }

  // -------------------------------------------------------------------------
  // Soft-delete (OKT-10 lifecycle_policy=soft_delete)
  // -------------------------------------------------------------------------

  /**
   * Soft-delete a user by setting enabled:false on the target.
   *
   * Per okta-dialect.md §3: Okta's primary deprovisioning signal is
   * `PATCH active:false`; the SCIM DELETE endpoint is a secondary path.
   * Both MUST yield the same end-state under soft_delete policy.
   *
   * Returns the updated StoredUser (enabled:false) or null if not found.
   * The skeleton's DELETE route returns 204 No Content on success; it
   * discards this return value. Returning it here makes the method
   * testable without inspecting the HTTP layer.
   */
  async softDelete(id: string): Promise<StoredUser | null> {
    const result = await this.client.softDeleteUser(id);
    return result ? acmeHrSystemToScim(result) : null;
  }

  // -------------------------------------------------------------------------
  // Health probe (Connector Law 8 OBSERVABLE)
  // -------------------------------------------------------------------------

  /**
   * Cheap liveness probe for /healthz. Calls listUsers() on the target;
   * resolves if reachable, rejects if not. The healthzRouter in the
   * skeleton calls this when present.
   *
   * For a production target with expensive list semantics, replace this
   * with a dedicated HEAD / or /ping endpoint on the target API.
   */
  async ping(): Promise<void> {
    await this.client.listUsers();
  }
}

// ---------------------------------------------------------------------------
// Internal helper — OIN step 16 case-sensitive override
// ---------------------------------------------------------------------------

/**
 * If the parsed filter AST is a simple top-level `<attr> eq <string>`,
 * return { attr, value }. Otherwise return null.
 *
 * Used to apply case-exact override for `userName eq <literal>` per
 * okta-dialect.md §2 (OIN test suite step 16). Pattern duplicated from
 * skeleton/store/user-store.ts — see that file's header comment for the
 * rationale for not extracting a shared utility yet.
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