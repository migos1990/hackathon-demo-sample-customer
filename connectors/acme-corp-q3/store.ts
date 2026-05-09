/**
 * AcmeCorpQ3UserStore — adapts the skeleton's UserStore interface to the
 * AcmeCorpQ3 native LDAP-shaped API.
 *
 * This is the connector's core: SCIM in (skeleton routes), native out
 * (client + mapping). Mirrors the AcmeHR reference store pattern at
 * connectors/acme-hr/store.ts.
 *
 * Key behaviors:
 *
 * 1. Soft-delete lifecycle (lifecycle_policy=soft_delete, OKT-57):
 *    SCIM DELETE → PATCH enabled=false on the native API (NOT a real delete).
 *    SCIM PATCH active=false → PATCH enabled=false on the native API.
 *    Both paths yield the same end-state per docs/okta-dialect.md §3.
 *
 * 2. Filter: in-memory (AcmeCorpQ3 has no server-side SCIM filter API).
 *    Fetch all, filter with scim2-parse-filter, then apply the OIN step 16
 *    case-sensitive override for `userName eq <literal>`.
 *    docs/okta-dialect.md §2 (case sensitivity) + OIN test suite step 16.
 *
 * 3. userName uniqueness: 409 from native API → UserNameConflictError →
 *    SCIM route maps to 409 + scimType:uniqueness per RFC 7644 §3.12 +
 *    docs/okta-dialect.md §8.
 *
 * 4. Pagination: RFC 7644 §3.4.2.4 (1-based startIndex, totalResults,
 *    itemsPerPage). docs/okta-dialect.md §7.
 *
 * 5. Healthz probe: ping() method calls listUsers — cheap reachability
 *    check for /healthz. Connector Law 8 OBSERVABLE.
 *
 * OIN citations:
 *   - docs/okta-dialect.md §2  (filter, case sensitivity)
 *   - docs/okta-dialect.md §3  (soft-delete)
 *   - docs/okta-dialect.md §7  (pagination)
 *   - docs/okta-dialect.md §8  (error envelope / uniqueness)
 *   - RFC 7644 §3.4.2.4        (pagination spec)
 *   - RFC 7644 §3.12           (error types)
 *   - OIN test suite step 16   (userName case sensitivity)
 */
import { parse, filter as makePredicate } from "scim2-parse-filter";
import type { ScimPatchOperation } from "scim-patch";
import type {
  UserStore,
  ListOptions,
  ListResult,
} from "../../skeleton/store/user-store.js";
import {
  UserNameConflictError,
} from "../../skeleton/store/user-store.js";
import type { ScimUser, StoredUser } from "../../skeleton/types.js";
import type { AcmeCorpQ3Client } from "./client.js";
import { AcmeCorpQ3ApiError } from "./client.js";
import {
  scimToAcmeCorpQ3Create,
  acmeCorpQ3ToScim,
  scimPatchToAcmeCorpQ3Patch,
} from "./mapping.js";

export class AcmeCorpQ3UserStore implements UserStore {
  constructor(private readonly client: AcmeCorpQ3Client) {}

  // -------------------------------------------------------------------------
  // Healthz probe — Connector Law 8 OBSERVABLE
  // -------------------------------------------------------------------------

  /**
   * Ping the native API. Called by the skeleton's /healthz route when the
   * store exposes a `ping()` method. Rejects if the native API is unreachable.
   */
  async ping(): Promise<void> {
    await this.client.listUsers();
  }

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    const nativeInput = scimToAcmeCorpQ3Create(input);
    try {
      const created = await this.client.createUser(nativeInput);
      return acmeCorpQ3ToScim(created);
    } catch (err) {
      if (err instanceof AcmeCorpQ3ApiError && err.status === 409) {
        // uid conflict on the native side → SCIM 409 + scimType:uniqueness.
        // docs/okta-dialect.md §8 + RFC 7644 §3.12.
        throw new UserNameConflictError(nativeInput.uid);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // READ
  // -------------------------------------------------------------------------

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user ? acmeCorpQ3ToScim(user) : null;
  }

  // -------------------------------------------------------------------------
  // LIST + FILTER
  // -------------------------------------------------------------------------

  /**
   * List users with optional SCIM filter and RFC 7644 §3.4.2.4 pagination.
   *
   * Filter strategy: fetch all from native API, filter in-memory.
   * AcmeCorpQ3's API has no server-side filter — this is the pragmatic
   * path for apps without SCIM-native query support (docs/patterns/ldap.md §1).
   * For a large user base (>10k) this is a known limitation — see RUNBOOK.md.
   *
   * Case-sensitive override: OIN test suite step 16 requires that
   * `userName eq "FOO"` and `userName eq "foo"` return DIFFERENT results.
   * scim2-parse-filter defaults to case-insensitive userName matching.
   * We apply a case-exact post-filter for simple `userName eq <literal>`
   * expressions. docs/okta-dialect.md §2.
   *
   * Pagination: startIndex is 1-based. Treat 0 as 1 (Okta may send either).
   * docs/okta-dialect.md §7.
   */
  async list(options: ListOptions): Promise<ListResult> {
    const all = await this.client.listUsers();
    const scimUsers = all.map(acmeCorpQ3ToScim);

    let matched = scimUsers;

    if (options.filter !== undefined && options.filter.trim() !== "") {
      const ast = parse(options.filter);
      const predicate = makePredicate(ast);
      matched = scimUsers.filter((u) =>
        predicate(u as unknown as Record<string, unknown>),
      );

      // OIN step 16 — case-sensitive override for simple `userName eq <literal>`.
      // docs/okta-dialect.md §2: Okta's spec test explicitly asserts that
      // case-varied filters return different results; scim2-parse-filter
      // is case-insensitive by default, so we override for the exact shape
      // Okta uses in the userName dedup lookup.
      const override = extractSimpleStringEqAttrAndValue(ast);
      if (override && override.attr === "userName") {
        matched = matched.filter((u) => u.userName === override.value);
      }
    }

    const total = matched.length;

    // RFC 7644 §3.4.2.4: startIndex is 1-based. Okta may send 0 — treat as 1.
    // docs/okta-dialect.md §7.
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = matched.slice(from, from + options.count);

    return { resources: page, total };
  }

  // -------------------------------------------------------------------------
  // PATCH (attribute updates + soft-delete deactivation)
  // -------------------------------------------------------------------------

  /**
   * Apply SCIM PATCH operations to a user.
   *
   * Translates ops to a native AcmeCorpQ3 patch object via mapping.ts,
   * then calls patchUser on the client.
   *
   * Soft-delete: if ops include active=false, the native patch will set
   * enabled=false. The row is NEVER deleted from the native API.
   * lifecycle_policy=soft_delete, docs/okta-dialect.md §3.
   *
   * Reactivation (PATCH active=true): sets enabled=true. Per
   * docs/okta-dialect.md §4 — if deactivation_attribute_clearing were
   * configured we would need to re-populate attributes here; OKT-57 does
   * not configure attribute clearing, so reactivation is a simple
   * enabled=true flip.
   *
   * Returns null if the native API returns 404 (user not found).
   * SCIM route maps null → 404 + scimType:noTarget.
   */
  async patch(
    id: string,
    operations: ScimPatchOperation[],
  ): Promise<StoredUser | null> {
    // Translate SCIM ops → native patch object.
    // Sequential application guaranteed by scimPatchToAcmeCorpQ3Patch's
    // for-loop (RFC 7644 §3.5.2 + docs/okta-dialect.md §1).
    const nativePatch = scimPatchToAcmeCorpQ3Patch(operations);

    // If the patch is empty after translation (all ops were no-ops / unknown
    // paths), we still need to return the current state — fetch + return.
    if (Object.keys(nativePatch).length === 0) {
      return this.get(id);
    }

    const updated = await this.client.patchUser(id, nativePatch);
    return updated ? acmeCorpQ3ToScim(updated) : null;
  }

  // -------------------------------------------------------------------------
  // DELETE (soft-delete implementation)
  // -------------------------------------------------------------------------

  /**
   * SCIM DELETE — soft-delete implementation per lifecycle_policy=soft_delete.
   *
   * Okta drives deactivation via PATCH active=false, NOT DELETE.
   * (docs/okta-dialect.md §3: "Okta's deprovisioning signal is PATCH
   * active:false, NOT DELETE.")
   *
   * However, the DELETE endpoint must exist and behave consistently with
   * the same policy — if an admin hits it directly, the end-state must be
   * the same as PATCH active=false (disabled row, not a deleted row).
   * docs/okta-dialect.md §3 Table "soft delete" row.
   *
   * Returns true if the user was found and deactivated; false if not found
   * (caller maps to 404).
   */
  async delete(id: string): Promise<boolean> {
    // Soft-delete: PATCH enabled=false rather than deleting the row.
    // docs/okta-dialect.md §3.
    const updated = await this.client.patchUser(id, { enabled: false });
    return updated !== null;
  }
}

// ---------------------------------------------------------------------------
// Internal helper — OIN step 16 case-sensitivity override
// ---------------------------------------------------------------------------

/**
 * If the AST root is a simple `<attr> eq <stringLiteral>` expression,
 * extract the attr name and literal value for case-exact override.
 * Returns null for compound/complex expressions — those fall through to
 * scim2-parse-filter's default semantics.
 *
 * Duplicated from skeleton/store/user-store.ts — see that file's header
 * for the rationale for keeping this local rather than shared.
 * docs/okta-dialect.md §2 (filter case sensitivity).
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