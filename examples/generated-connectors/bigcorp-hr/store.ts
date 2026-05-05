/**
 * BigCorpHrUserStore — adapts the skeleton's UserStore interface to
 * BigCorpHR's native LDAP-shaped API via client.ts + mapping.ts.
 *
 * This IS the connector: SCIM in (via skeleton routes), BigCorpHR out
 * (via HttpBigCorpHrClient + attribute mapping).
 *
 * Flow:
 *   1. SCIM request → skeleton routes (skeleton/routes/users.ts)
 *   2. Skeleton calls this store's create / get / list / patch / delete
 *   3. This store invokes mapping.ts to translate payloads
 *   4. This store invokes client.ts to hit BigCorpHR's API
 *   5. Response translates BigCorpHR → SCIM on the way back
 *
 * Filter + pagination:
 *   BigCorpHR has no server-side filter API — fetch all, filter in memory.
 *   Per okta-dialect.md §2 field-confirmed pattern: "fetch all, filter in
 *   memory" is the pragmatic path for target apps without native SCIM filter
 *   support. For BigCorpHR installations with >10k users, a filter-pushdown
 *   adapter should be built and wired in (tracked in RUNBOOK.md limitations).
 *
 * Case-sensitivity: OIN test suite step 16 asserts `userName eq "FOO"` and
 *   `userName eq "foo"` return DIFFERENT results. scim2-parse-filter matches
 *   case-insensitively by default; we override with a post-filter pass for
 *   simple `userName eq <literal>` expressions per okta-dialect.md §2.
 *
 * Lifecycle policy: soft_delete (ticket SCIM-LIVE-PROBE).
 *   delete() calls client.deleteUser() which PATCHes enabled:false; never
 *   hard-removes. Per okta-dialect.md §3.
 *
 * Atomicity: scim-patch applies operations sequentially in document order per
 *   RFC 7644 §3.5.2. The patch delta is sent to BigCorpHR in a single PATCH
 *   call — all-or-nothing from the target's perspective.
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
import type { BigCorpHrClient } from "./client.js";
import { BigCorpHrApiError } from "./client.js";
import {
  scimToBigCorpHrCreate,
  bigCorpHrToScim,
  scimPatchToBigCorpHrPatch,
} from "./mapping.js";

export class BigCorpHrUserStore implements UserStore {
  constructor(private readonly client: BigCorpHrClient) {}

  // ─── Healthcheck probe ────────────────────────────────────────────────────

  /**
   * Cheap target-reachability probe for GET /scim/v2/healthz.
   * Connector Law 8 (OBSERVABLE): /healthz must reflect target health.
   * The skeleton's healthzRouter looks for a `ping()` method on the store
   * and calls it; rejects → 503.
   *
   * Uses listUsers (cheap, stable endpoint). For BigCorpHR installations
   * where listUsers is expensive (large user base), replace with a dedicated
   * HEAD /users or /health endpoint if available.
   */
  async ping(): Promise<void> {
    await this.client.listUsers();
  }

  // ─── UserStore interface ──────────────────────────────────────────────────

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    let native;
    try {
      native = scimToBigCorpHrCreate(input);
    } catch (err) {
      // Mapping validation failure (missing userName or mail) — re-throw
      // with a clear message. The SCIM route layer catches Error and maps to
      // 400 with the message in `detail`.
      throw new Error(
        `Mapping validation failed: ${(err as Error).message}`,
      );
    }

    try {
      const created = await this.client.createUser(native);
      return bigCorpHrToScim(created);
    } catch (err) {
      if (err instanceof BigCorpHrApiError && err.status === 409) {
        // BigCorpHR returned 409 = uid (userName) already exists.
        // Translate to skeleton's UserNameConflictError so the SCIM route
        // maps it to 409 + scimType:uniqueness per RFC 7644 §3.12 and
        // okta-dialect.md §8.
        throw new UserNameConflictError(native.uid);
      }
      throw err;
    }
  }

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user ? bigCorpHrToScim(user) : null;
  }

  async list(options: ListOptions): Promise<ListResult> {
    // Fetch all users from BigCorpHR; filter in memory.
    // BigCorpHR has no native filter API — okta-dialect.md §2 field pattern.
    const all = await this.client.listUsers();
    const scimUsers = all.map(bigCorpHrToScim);

    let matched = scimUsers;

    if (options.filter !== undefined && options.filter.trim() !== "") {
      let ast: unknown;
      try {
        ast = parse(options.filter);
      } catch (parseErr) {
        // Malformed filter string — re-throw; users.ts route maps to 400
        // invalidFilter per RFC 7644 §3.12.
        throw new Error(
          `Malformed filter: ${(parseErr as Error).message}`,
        );
      }

      const predicate = makePredicate(ast as Parameters<typeof makePredicate>[0]);
      matched = scimUsers.filter(
        (u) => predicate(u as unknown as Record<string, unknown>),
      );

      // OIN test suite step 16: case-sensitive override for simple
      // `userName eq <literal>` filter expressions. scim2-parse-filter
      // defaults to case-insensitive matching (RFC 7643 caseExact=false for
      // userName), but Okta's spec test explicitly asserts case-sensitive
      // semantics. See okta-dialect.md §2 (FIELD-CONFIRMED, costs hours).
      const csOverride = extractSimpleStringEqAttrAndValue(ast);
      if (csOverride && csOverride.attr === "userName") {
        matched = matched.filter((u) => u.userName === csOverride.value);
      }
    }

    const total = matched.length;
    // startIndex is 1-based per RFC 7644 §3.4.2.4. Treat 0 as 1 per
    // okta-dialect.md §7 (Okta may send either).
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = matched.slice(from, from + options.count);

    return { resources: page, total };
  }

  async patch(
    id: string,
    operations: ScimPatchOperation[],
  ): Promise<StoredUser | null> {
    // Translate SCIM patch ops into a BigCorpHR patch delta.
    // Sequential application is guaranteed by the for-loop in
    // scimPatchToBigCorpHrPatch — RFC 7644 §3.5.2 compliance.
    const delta = scimPatchToBigCorpHrPatch(operations);

    // If no translatable fields were extracted (all ops targeted unknown paths),
    // fetch and return the current user unchanged. This preserves the 200 +
    // current-body contract per okta-dialect.md §1 without a no-op PATCH call.
    if (Object.keys(delta).length === 0) {
      return this.get(id);
    }

    const updated = await this.client.patchUser(id, delta);
    return updated ? bigCorpHrToScim(updated) : null;
  }

  /**
   * Soft-delete entry point for SCIM DELETE /Users/{id}.
   *
   * Lifecycle policy: soft_delete (ticket SCIM-LIVE-PROBE).
   * Per okta-dialect.md §3:
   *   - Okta's deprovisioning signal is PATCH active:false, NOT DELETE.
   *   - DELETE endpoint is implemented for edge-case admin-initiated removal.
   *   - Both paths MUST yield the same end-state (enabled:false, row retained).
   *
   * Returns the deactivated user (so the route can confirm the operation)
   * or null if the user was not found (route maps to 404).
   *
   * NOTE: The skeleton's UserStore interface does not yet include a `delete`
   * method (it's added as an extension here). The SCIM route in routes/users.ts
   * already handles DELETE by calling store.delete — the generated users.ts
   * for this connector wires this up. If using the base skeleton route,
   * see connectors/bigcorp-hr/routes/users.ts (generated alongside store).
   */
  async delete(id: string): Promise<StoredUser | null> {
    const deactivated = await this.client.deleteUser(id);
    return deactivated ? bigCorpHrToScim(deactivated) : null;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * If the AST is a simple top-level `<attr> eq <stringLiteral>`, return the
 * attr path + literal so the caller can apply case-exact matching.
 * Returns null for anything else (logical compositions, non-string comparisons,
 * filter-path expressions, etc.) — those fall back to library semantics.
 *
 * Used for the OIN step 16 case-sensitive override on userName queries.
 * See okta-dialect.md §2. Duplicated from skeleton/store/user-store.ts:54-66
 * — extracting a shared helper is post-hackathon scope.
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