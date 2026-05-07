/**
 * AcmeHrSystemUserStore — implements the skeleton's UserStore interface,
 * backed by the Acme HR System native API via HttpAcmeHrSystemClient.
 *
 * ticket: OKT-10
 * customer: Acme HR System
 * slug: acme-hr-system
 *
 * This is the connector's core integration layer:
 *   SCIM request → skeleton routes → this store → mapping → client → target API
 *
 * lifecycle_policy: soft_delete (OKT-10)
 *   - PATCH active:false → client.patchUser({enabled:false})
 *   - DELETE /Users/:id  → client.softDeleteUser() (same as above)
 *   - Per okta-dialect.md §3: Okta drives lifecycle through PATCH active:false,
 *     not DELETE. DELETE is implemented here for edge-case admin flows but
 *     ALWAYS executes a soft delete, never a hard delete.
 *   - Rows are NEVER removed from the target system. Audit retention preserved.
 *
 * Filter + pagination: AcmeHrSystem has no server-side filter API; we fetch
 * all users and filter in memory. For tenants with >10k users, the generated
 * connector's RUNBOOK.md captures this as a known limitation.
 *
 * Case-sensitive userName filter: OIN test suite step 16 asserts case-exact
 * match per okta-dialect.md §2. The scim2-parse-filter library matches
 * case-insensitively by default; we override for simple `userName eq <literal>`
 * filters. The same override pattern appears in skeleton/store/user-store.ts.
 *
 * ping() / health probe: exposes a lightweight target-reachability check
 * for /healthz (Connector Law 8 OBSERVABLE). Duck-typed — skeleton's
 * healthzRouter calls ping() if present.
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

  // -------------------------------------------------------------------------
  // Health probe (Connector Law 8 OBSERVABLE)
  // -------------------------------------------------------------------------

  /**
   * Cheap target-reachability check for /healthz.
   * Calls listUsers() — cheap on a typical directory, acceptable for a health
   * probe. If the target exposes a dedicated /health or HEAD / endpoint,
   * prefer that for generated connectors with large user sets.
   */
  async ping(): Promise<void> {
    await this.client.listUsers();
  }

  // -------------------------------------------------------------------------
  // UserStore interface
  // -------------------------------------------------------------------------

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    const nativeInput = scimToAcmeHrSystemCreate(input);
    try {
      const created = await this.client.createUser(nativeInput);
      return acmeHrSystemToScim(created);
    } catch (err) {
      if (err instanceof AcmeHrSystemApiError && err.status === 409) {
        // Translate native 409 (uid conflict) into skeleton's UserNameConflictError.
        // The SCIM route layer maps this to 409 + scimType:uniqueness per
        // RFC 7644 §3.12 and okta-dialect.md §8.
        throw new UserNameConflictError(nativeInput.uid);
      }
      throw err;
    }
  }

  async get(id: string): Promise<StoredUser | null> {
    const native = await this.client.getUser(id);
    return native ? acmeHrSystemToScim(native) : null;
  }

  async patch(
    id: string,
    operations: ScimPatchOperation[],
  ): Promise<StoredUser | null> {
    // Translate SCIM PATCH ops → native patch payload.
    // Per okta-dialect.md §1: ops are processed sequentially (accumulated
    // into a single native patch object); the result is sent in one request.
    // lifecycle_policy soft_delete: active:false → enabled:false (never deletes).
    const nativePatch = scimPatchToAcmeHrSystemPatch(operations);

    // If the patch is empty (all ops were unknown-path no-ops), still call
    // patchUser so the target can stamp lastModified. Some targets are fine
    // with an empty PATCH body; if the target rejects it, the RUNBOOK.md
    // should document the behaviour. For now: pass through.
    const updated = await this.client.patchUser(id, nativePatch);
    return updated ? acmeHrSystemToScim(updated) : null;
  }

  async list(options: ListOptions): Promise<ListResult> {
    // No server-side filter API on AcmeHrSystem — fetch all, filter in memory.
    // Known limitation documented in RUNBOOK.md §Known limitations.
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
      // scim2-parse-filter matches case-insensitively by default; override
      // to case-SENSITIVE for simple `userName eq <literal>` filters.
      // Per okta-dialect.md §2 "Case sensitivity — THE Okta quirk".
      const override = extractSimpleStringEqAttrAndValue(ast);
      if (override !== null && override.attr === "userName") {
        matched = matched.filter((u) => u.userName === override.value);
      }
    }

    const total = matched.length;
    // RFC 7644 §3.4.2.4: startIndex is 1-based. Treat 0 as 1 per okta-dialect.md §7.
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = matched.slice(from, from + options.count);

    return { resources: page, total };
  }

  // -------------------------------------------------------------------------
  // Soft-delete  (lifecycle_policy: soft_delete — OKT-10)
  // -------------------------------------------------------------------------

  /**
   * Implements the soft-delete path triggered when Okta (or an admin) issues
   * DELETE /Users/:id. Per okta-dialect.md §3:
   *   "Okta does NOT use DELETE /Users/{id} at all in the standard lifecycle.
   *   The DELETE endpoint may be implemented for edge cases (admin-initiated
   *   forced removal on the customer app side) but Okta itself drives lifecycle
   *   through the `active` flag."
   *
   * lifecycle_policy: soft_delete means we NEVER remove the row. We set
   * enabled:false and return the deactivated user. The SCIM route layer
   * returns 204 No Content on successful soft-delete (standard DELETE
   * semantics), so the caller discards the return value.
   */
  async softDelete(id: string): Promise<StoredUser | null> {
    const updated = await this.client.softDeleteUser(id);
    return updated ? acmeHrSystemToScim(updated) : null;
  }
}

// ---------------------------------------------------------------------------
// Private: OIN step 16 case-exact override helper
// Duplicated from skeleton/store/user-store.ts:54-66 per the rationale in
// connectors/acme-hr/store.ts header: extraction deferred to post-hackathon.
// ---------------------------------------------------------------------------

/**
 * If the filter AST is exactly `<attr> eq <stringLiteral>`, return the attr
 * and value for the caller's case-exact override. Returns null for anything
 * more complex (logical compositions, non-string comparisons, etc.) —
 * those fall back to library (case-insensitive) semantics.
 *
 * Per okta-dialect.md §2: Okta's OIN test suite step 16 asserts that
 * `filter=userName eq "FOO"` and `filter=userName eq "foo"` yield DIFFERENT
 * results. The library's default violates this; this helper enables the
 * post-filter narrowing that restores compliance.
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