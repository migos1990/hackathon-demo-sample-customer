/**
 * AcmeHrSystemUserStore — adapts the skeleton's UserStore interface to Acme
 * HR System's native LDAP-shaped API.
 *
 * This IS the connector: SCIM in (via skeleton routes), Acme HR System out
 * (via client + mapping). Mirrors connectors/acme-hr/store.ts in structure.
 *
 * Soft-delete policy (OKT-10 lifecycle_policy: soft_delete):
 *   - `store.delete(id)` calls client.deactivateUser — never physically
 *     removes the row. docs/okta-dialect.md §3.
 *   - `store.patch(id, [{op:"replace",value:{active:false}}])` also calls
 *     client.deactivateUser (via mapping) for policy consistency.
 *   - Deactivated users ARE still returned by get() (Okta may re-activate).
 *   - Deactivated users are HIDDEN from the default unfiltered list()
 *     per docs/okta-dialect.md §4 "active: false MUST hide the user from
 *     unfiltered GET /Users."
 *
 * Filter + pagination per RFC 7644 §3.4.2.4 and docs/okta-dialect.md §7.
 * In-memory filter (no server-side SCIM filter support on Acme HR System —
 * fetch-all then filter). See RUNBOOK.md §6 "Known limitations".
 *
 * Case-sensitive userName filter override: OIN test suite step 16 asserts
 * `userName eq "FOO"` ≠ `userName eq "foo"`. The scim2-parse-filter library
 * defaults case-insensitive; we override for simple `userName eq <literal>`
 * per docs/okta-dialect.md §2.
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

// The UserStore interface does not include `delete` — the skeleton routes.ts
// calls it directly. We extend the interface here so the router can call
// store.delete without a cast. The store is injected into the router factory
// as `UserStore & { delete?: (id: string) => Promise<boolean> }`.
export interface AcmeHrSystemUserStoreInterface extends UserStore {
  /**
   * Soft-delete a user by id. Returns true if the user was found and
   * deactivated; false if the user did not exist (404 from target).
   * Never physically deletes — docs/okta-dialect.md §3 soft_delete policy.
   */
  delete(id: string): Promise<boolean>;
  /**
   * Liveness probe for /healthz (Connector Law 8 OBSERVABLE).
   * docs/okta-dialect.md §9 "Rate limiting".
   */
  ping(): Promise<void>;
}

export class AcmeHrSystemUserStore
  implements AcmeHrSystemUserStoreInterface
{
  constructor(private readonly client: AcmeHrSystemClient) {}

  // -------------------------------------------------------------------------
  // Liveness probe
  // -------------------------------------------------------------------------

  /**
   * Verify the target API is reachable. Called by skeleton's healthzRouter
   * when it detects a `ping` method on the injected store.
   * Uses listUsers() — cheap for small directories; replace with a dedicated
   * HEAD or /ping endpoint if Acme HR System ever exposes one.
   */
  async ping(): Promise<void> {
    await this.client.listUsers();
  }

  // -------------------------------------------------------------------------
  // UserStore interface
  // -------------------------------------------------------------------------

  async create(
    input: Omit<ScimUser, "id" | "meta">,
  ): Promise<StoredUser> {
    const nativeInput = scimToAcmeHrSystemCreate(input);
    try {
      const created = await this.client.createUser(nativeInput);
      return acmeHrSystemToScim(created);
    } catch (err) {
      if (err instanceof AcmeHrSystemApiError && err.status === 409) {
        // Target returned 409 uid conflict → translate to skeleton's
        // UserNameConflictError. The SCIM route maps this to
        // 409 + scimType:"uniqueness" per RFC 7644 §3.12 and
        // docs/okta-dialect.md §8.
        throw new UserNameConflictError(nativeInput.uid);
      }
      throw err;
    }
  }

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user !== null ? acmeHrSystemToScim(user) : null;
  }

  async list(options: ListOptions): Promise<ListResult> {
    // Fetch all from target; filter/paginate in memory.
    // Rationale: Acme HR System has no server-side SCIM filter API.
    // Performance caveat: documented in RUNBOOK.md §6.
    const all = await this.client.listUsers();
    const scimUsers = all.map(acmeHrSystemToScim);

    // Default unfiltered list: hide inactive users per docs/okta-dialect.md §4.
    // "active: false MUST hide the user from unfiltered GET /Users."
    // When a filter IS provided, let it control visibility so admins can
    // query inactive users explicitly (e.g. `active eq false`).
    let candidates =
      options.filter !== undefined && options.filter.trim() !== ""
        ? scimUsers
        : scimUsers.filter((u) => u.active !== false);

    if (options.filter !== undefined && options.filter.trim() !== "") {
      let ast: unknown;
      try {
        ast = parse(options.filter);
      } catch (err) {
        // Malformed filter — propagate as a plain Error; the route handler
        // catches it and returns 400 + scimType:"invalidFilter" per
        // RFC 7644 §3.12 and docs/okta-dialect.md §8.
        throw new Error(
          `Malformed SCIM filter: ${(err as Error).message}`,
        );
      }

      const predicate = makePredicate(ast as Parameters<typeof makePredicate>[0]);
      candidates = candidates.filter((u) =>
        predicate(u as unknown as Record<string, unknown>),
      );

      // OIN test suite step 16 — case-sensitive override for simple
      // `userName eq <literal>` filter. The scim2-parse-filter library
      // matches userName case-insensitively by default (RFC 7643 caseExact=false
      // default). Okta's spec test explicitly asserts case-SENSITIVE behavior.
      // docs/okta-dialect.md §2 "Case sensitivity — THE Okta quirk".
      const override = extractSimpleEqString(ast);
      if (override !== null && override.attr === "userName") {
        candidates = candidates.filter(
          (u) => u.userName === override.value,
        );
      }
    }

    const total = candidates.length;
    // RFC 7644 §3.4.2.4: startIndex is 1-based. Treat 0 as 1 per
    // docs/okta-dialect.md §7.
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = candidates.slice(from, from + options.count);

    return { resources: page, total };
  }

  async patch(
    id: string,
    operations: ScimPatchOperation[],
  ): Promise<StoredUser | null> {
    const nativePatch = scimPatchToAcmeHrSystemPatch(operations);

    // If the patch resolves to nothing actionable, still call the target to
    // remain idempotent (target decides if it's a no-op). Only skip the
    // round-trip when the patch object is completely empty.
    if (Object.keys(nativePatch).length === 0) {
      // Return current state — PATCH with no effective changes is idempotent.
      return this.get(id);
    }

    const updated = await this.client.patchUser(id, nativePatch);
    return updated !== null ? acmeHrSystemToScim(updated) : null;
  }

  // -------------------------------------------------------------------------
  // Soft-delete (OKT-10 lifecycle_policy: soft_delete)
  // -------------------------------------------------------------------------

  /**
   * Soft-delete: flip enabled=false, never physically remove.
   *
   * docs/okta-dialect.md §3: "Okta's deprovisioning signal is PATCH
   * active: false, NOT DELETE." The SCIM DELETE endpoint is implemented
   * here as required by OKT-10 `users_delete: true`, but it maps to the
   * same soft-delete outcome to ensure policy consistency:
   *
   *   DELETE /Users/:id  →  PATCH { enabled: false }  on the native API
   *   PATCH  active:false →  PATCH { enabled: false }  on the native API
   *                          ↑ same outcome, same policy.
   *
   * Returns true when the user was found + deactivated; false on 404.
   */
  async delete(id: string): Promise<boolean> {
    const updated = await this.client.deactivateUser(id);
    return updated !== null;
  }
}

// ---------------------------------------------------------------------------
// AST helper — case-sensitive override for OIN step 16
// ---------------------------------------------------------------------------

/**
 * If the AST is a simple top-level `<attr> eq <stringLiteral>`, return the
 * attr + value so the caller can apply case-exact matching. Returns null for
 * anything more complex (logical compositions, filter-paths with brackets,
 * non-string comparisons). This is an Okta-dialect override, not a general
 * RFC 7644 improvement. docs/okta-dialect.md §2.
 */
function extractSimpleEqString(
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