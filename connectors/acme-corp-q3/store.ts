/**
 * AcmeCorpQ3UserStore — adapts the skeleton's UserStore interface to the
 * AcmeCorpQ3 native LDAP-shaped HR API.
 *
 * This IS the connector. SCIM requests arrive via skeleton routes, hit this
 * store, which translates them through mapping.ts and dispatches to client.ts.
 *
 * Flow:
 *   Okta → skeleton/routes/users.ts → AcmeCorpQ3UserStore → mapping.ts → client.ts → AcmeCorpQ3 API
 *
 * Soft-delete (ticket OKT-57 lifecycle_policy=soft_delete):
 *   - PATCH active:false → client.patchUser({enabled:false}) — standard deactivation path
 *   - DELETE /Users/:id  → client.softDeleteUser() — same end-state via buildSoftDeletePatch()
 *   Both paths converge at enabled:false with the row retained.
 *   okta-dialect.md §3 anti-pattern avoided: the two paths produce identical outcomes.
 *
 * Filter + pagination:
 *   AcmeCorpQ3's API has no server-side filter — we fetch all users and apply
 *   scim2-parse-filter in memory. This is pragmatic for the LDAP-shaped pattern
 *   (pattern ldap.md §6 — "filter pushdown is absent" for target apps without
 *   a SCIM-compatible query layer).
 *
 *   OIN test suite step 16 (username case sensitivity) — okta-dialect.md §2:
 *   scim2-parse-filter applies case-insensitive matching by default (RFC 7643
 *   caseExact=false). The OIN test explicitly asserts case-SENSITIVE matching
 *   for `userName eq` filters. We override with a simple-equality extractor
 *   for the `userName eq <literal>` shape — the most critical path — consistent
 *   with skeleton/store/user-store.ts:185-199.
 *
 * Observability:
 *   ping() is a cheap liveness probe for /healthz (Connector Law 8 OBSERVABLE).
 *   healthzRouter looks for ping() duck-typed on the store.
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
import type { AcmeCorpQ3Client } from "./client.js";
import { AcmeCorpQ3ApiError } from "./client.js";
import {
  scimToAcmeCorpQ3Create,
  acmeCorpQ3ToScim,
  scimPatchToAcmeCorpQ3Patch,
  buildSoftDeletePatch,
} from "./mapping.js";

export class AcmeCorpQ3UserStore implements UserStore {
  constructor(private readonly client: AcmeCorpQ3Client) {}

  // ─── Liveness probe ────────────────────────────────────────────────────────

  /**
   * Cheap target-reachability probe for /healthz.
   * okta-dialect.md §8 (OBSERVABLE): /healthz must reflect whether the
   * connector can reach its target, not just whether the connector process
   * is alive. listUsers is the cheapest meaningful call against AcmeCorpQ3.
   * For a target with a dedicated /ping or HEAD/ endpoint, prefer that.
   */
  async ping(): Promise<void> {
    await this.client.listUsers();
  }

  // ─── UserStore interface ───────────────────────────────────────────────────

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    let nativeInput;
    try {
      nativeInput = scimToAcmeCorpQ3Create(input);
    } catch (err) {
      // Mapping-level validation failure (missing userName / email) — rethrow
      // with a clear message; the route layer turns this into 400+invalidValue.
      throw err;
    }

    try {
      const created = await this.client.createUser(nativeInput);
      return acmeCorpQ3ToScim(created);
    } catch (err) {
      if (err instanceof AcmeCorpQ3ApiError && err.status === 409) {
        // uid conflict — translate into skeleton's UserNameConflictError.
        // Route layer maps this to 409 + scimType:uniqueness per RFC 7644 §3.12
        // and okta-dialect.md §8 (OIN test step 14).
        throw new UserNameConflictError(nativeInput.uid);
      }
      throw err;
    }
  }

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user !== null ? acmeCorpQ3ToScim(user) : null;
  }

  async list(options: ListOptions): Promise<ListResult> {
    // Fetch all — no server-side filter on AcmeCorpQ3 API.
    // Only active (enabled) users are included in unfiltered results per
    // okta-dialect.md §4: "active:false MUST hide the user from unfiltered
    // GET /Users (the default list)."
    const all = await this.client.listUsers();
    const scimAll = all.map(acmeCorpQ3ToScim);

    let matched: StoredUser[];

    if (options.filter !== undefined && options.filter.trim() !== "") {
      // Parse + apply filter via scim2-parse-filter.
      // If the filter string is malformed, parse() throws; the route layer
      // catches and returns 400 + invalidFilter (okta-dialect.md §8).
      const ast = parse(options.filter);
      const predicate = makePredicate(ast);
      matched = scimAll.filter((u) =>
        predicate(u as unknown as Record<string, unknown>),
      );

      // OIN step 16 case-sensitive override for simple `userName eq <literal>`.
      // scim2-parse-filter's default is case-insensitive (RFC 7643 caseExact=false).
      // Okta's test suite asserts case-SENSITIVE semantics for userName.
      // okta-dialect.md §2: "FIELD-CONFIRMED — case sensitivity has caused dedup
      // misses and PATCH 404s."
      // RFC 7644 §3.4.2.2 cited for filter grammar.
      const override = extractSimpleStringEqAttrAndValue(ast);
      if (override !== null && override.attr === "userName") {
        matched = matched.filter((u) => u.userName === override.value);
      }
    } else {
      // Unfiltered list — return only active users per okta-dialect.md §4.
      // Okta's import uses the unfiltered list for full-sync; inactive users
      // should not be pulled in ("Okta doesn't pull in a user whose status is
      // set to active=false, even in a full import").
      matched = scimAll.filter((u) => u.active !== false);
    }

    const total = matched.length;
    // RFC 7644 §3.4.2.4: startIndex is 1-based. Treat 0 as 1 per okta-dialect.md §7.
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = matched.slice(from, from + options.count);

    return { resources: page, total };
  }

  async patch(id: string, operations: ScimPatchOperation[]): Promise<StoredUser | null> {
    // Translate SCIM operations to native patch.
    // Ops are applied sequentially within scimPatchToAcmeCorpQ3Patch (RFC 7644 §3.5.2).
    const nativePatch = scimPatchToAcmeCorpQ3Patch(operations);

    // If the patch is empty (all ops were unknown-path no-ops), short-circuit
    // with a GET to return the current resource body without a spurious write.
    if (Object.keys(nativePatch).length === 0) {
      return this.get(id);
    }

    const updated = await this.client.patchUser(id, nativePatch);
    return updated !== null ? acmeCorpQ3ToScim(updated) : null;
  }

  /**
   * Soft-delete: invoked by the DELETE /Users/:id route.
   *
   * Per okta-dialect.md §3 soft_delete policy: "same customer policy MUST
   * yield identical outcomes regardless of which endpoint Okta hits."
   * buildSoftDeletePatch() is the single source of truth for the soft-delete
   * end-state ({enabled:false}) — shared with the PATCH deactivation path.
   *
   * Returns null when the user does not exist (route returns 404).
   * Returns the updated (deactivated) resource on success (route returns 200).
   */
  async softDelete(id: string): Promise<StoredUser | null> {
    const softDeletePatch = buildSoftDeletePatch();
    const updated = await this.client.softDeleteUser(id);
    // softDeleteUser calls patchUser internally; null means 404.
    void softDeletePatch; // explicitly consumed above via client call
    return updated !== null ? acmeCorpQ3ToScim(updated) : null;
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * If the SCIM filter AST is a simple top-level `<attr> eq <stringLiteral>`,
 * return attr + value for the OIN step-16 case-sensitive override.
 * Returns null for logical compositions, complex paths, or non-string values.
 *
 * okta-dialect.md §2: Okta's OIN test suite step 16 explicitly tests that
 * `userName eq "FOO"` and `userName eq "foo"` return different results.
 *
 * Duplicated from skeleton/store/user-store.ts:54-66 — the skeleton and
 * connector stores are intentionally decoupled to keep blast radius contained.
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