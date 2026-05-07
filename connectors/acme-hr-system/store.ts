/**
 * AcmeHrSystemUserStore — adapts the skeleton's UserStore interface to Acme
 * HR System's native LDAP-shaped API (OKT-10).
 *
 * This IS the connector core: SCIM in (via skeleton routes), Acme HR System
 * out (via HttpAcmeHrSystemClient + mapping functions).
 *
 * Flow:
 *   SCIM request → skeleton/routes/users.ts → this store
 *     → mapping.ts (translate payload)
 *     → client.ts (HTTP to Acme HR System)
 *     → mapping.ts (translate response)
 *   → SCIM response
 *
 * Lifecycle (soft_delete per OKT-10):
 *   - PATCH active:false  → client.patchUser({enabled:false}) + row retained
 *   - DELETE /Users/:id   → client.deactivateUser() (same as above — NO
 *                           row removal). Per okta-dialect.md §3: "PATCH
 *                           active: false handler and DELETE handler MUST be
 *                           policy-consistent." Both paths produce the same
 *                           end-state: user row exists, enabled=false.
 *
 * Filter + pagination for list() follow skeleton/store/user-store.ts:176-207:
 *   - Fetch all from Acme HR System (no server-side filter API).
 *   - Filter in memory via scim2-parse-filter.
 *   - Apply OIN step 16 case-sensitive override for simple `userName eq`
 *     filters (okta-dialect.md §2).
 *
 * Case sensitivity (okta-dialect.md §2, OIN test suite step 16 "Username Case
 * Sensitivity Check"): `userName eq "FOO"` and `userName eq "foo"` MUST return
 * different results. scim2-parse-filter defaults to case-insensitive for
 * userName (RFC 7643 caseExact=false default). We override to case-SENSITIVE
 * on the simple `attr eq literal` pattern — same approach as the reference
 * implementation at connectors/acme-hr/store.ts:62-74.
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

// ── Store implementation ───────────────────────────────────────────────────────

export class AcmeHrSystemUserStore implements UserStore {
  constructor(private readonly client: AcmeHrSystemClient) {}

  // ── Health probe (Connector Law 8 OBSERVABLE) ─────────────────────────────

  /**
   * Cheap reachability probe for GET /scim/v2/healthz.
   * The skeleton's healthzRouter calls ping() when present on the store.
   * Rejects if Acme HR System is unreachable; resolves on any successful
   * list response (even an empty one).
   *
   * For a target with expensive list semantics, replace with a HEAD /
   * or a dedicated /health endpoint on the customer API.
   */
  async ping(): Promise<void> {
    await this.client.listUsers();
  }

  // ── create ────────────────────────────────────────────────────────────────

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    const nativeInput = scimToAcmeHrSystemCreate(input);
    try {
      const created = await this.client.createUser(nativeInput);
      return acmeHrSystemToScim(created);
    } catch (err) {
      if (err instanceof AcmeHrSystemApiError && err.status === 409) {
        // Translate uid conflict → UserNameConflictError so the SCIM route
        // maps it to 409 + scimType:uniqueness per RFC 7644 §3.12
        // and okta-dialect.md §8 (OIN SPEC test step 14).
        throw new UserNameConflictError(nativeInput.uid);
      }
      throw err;
    }
  }

  // ── get ───────────────────────────────────────────────────────────────────

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user ? acmeHrSystemToScim(user) : null;
  }

  // ── list ──────────────────────────────────────────────────────────────────

  /**
   * Fetch-all-and-filter-in-memory strategy (see header comment).
   *
   * Acme HR System has no server-side SCIM filter API. This is the pragmatic
   * path; for targets with filter support, push the predicate down for
   * efficiency (especially important at >10k users — see RUNBOOK.md
   * §Known Limitations).
   *
   * RFC 7644 §3.4.2.4: startIndex is 1-based. Treat 0 as 1
   * (okta-dialect.md §7).
   */
  async list(options: ListOptions): Promise<ListResult> {
    const allNative = await this.client.listUsers();
    const allScim = allNative.map(acmeHrSystemToScim);

    let matched = allScim;

    if (options.filter !== undefined && options.filter.trim() !== "") {
      const ast = parse(options.filter);
      const predicate = makePredicate(ast);
      matched = allScim.filter((u) =>
        predicate(u as unknown as Record<string, unknown>),
      );

      // OIN test suite step 16 — case-sensitive override for simple
      // `userName eq <literal>` filters.
      // okta-dialect.md §2: "Okta's spec test expects CASE-SENSITIVE matching
      // by default." scim2-parse-filter uses case-insensitive semantics by
      // default; we narrow to exact-match after the library pass.
      // Reference: connectors/acme-hr/store.ts:62-74.
      const caseExact = extractSimpleStringEq(ast);
      if (caseExact !== null && caseExact.attr === "userName") {
        matched = matched.filter((u) => u.userName === caseExact.value);
      }
    }

    const total = matched.length;
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = matched.slice(from, from + options.count);

    return { resources: page, total };
  }

  // ── patch ─────────────────────────────────────────────────────────────────

  /**
   * Translate SCIM PATCH operations → AcmeHrSystemUserPatch and forward
   * to the target API.
   *
   * Operations are applied atomically per RFC 7644 §3.5.2 at the target
   * level: we send a single PATCH body containing all translated field
   * changes. If the target rejects it, no partial-update window exists.
   *
   * okta-dialect.md §1: Okta returns 200 + full resource body on PATCH,
   * not 204 — the skeleton route handles this; we just return the StoredUser.
   */
  async patch(
    id: string,
    operations: ScimPatchOperation[],
  ): Promise<StoredUser | null> {
    const nativePatch = scimPatchToAcmeHrSystemPatch(operations);

    // If no recognised ops were found, return the current user state
    // (idempotent no-op) rather than sending an empty PATCH body.
    if (Object.keys(nativePatch).length === 0) {
      return this.get(id);
    }

    const updated = await this.client.patchUser(id, nativePatch);
    return updated ? acmeHrSystemToScim(updated) : null;
  }

  // ── delete (soft) ─────────────────────────────────────────────────────────

  /**
   * Soft-delete: mark `enabled: false` via the target API.
   *
   * OKT-10 lifecycle_policy: soft_delete — rows are NEVER removed from
   * Acme HR System (7-year compliance retention). This method is called by
   * the DELETE /Users/:id route in the SCIM layer.
   *
   * Per okta-dialect.md §3: "DELETE handler and PATCH-active-false handler
   * MUST be policy-consistent." Both paths call client.deactivateUser()
   * which sends PATCH {enabled:false}.
   *
   * Returns null when the user does not exist (idempotent — caller maps
   * null to 404 per RFC 7644).
   */
  async delete(id: string): Promise<StoredUser | null> {
    const updated = await this.client.deactivateUser(id);
    return updated ? acmeHrSystemToScim(updated) : null;
  }
}

// ── AST helpers ───────────────────────────────────────────────────────────────

/**
 * If the AST is a simple top-level `<attr> eq <stringLiteral>`, return
 * {attr, value}; otherwise return null. Used for the OIN step 16
 * case-sensitive override on userName queries.
 *
 * Duplicated from skeleton/store/user-store.ts:54-66. See store header
 * comment for deduplication rationale.
 *
 * okta-dialect.md §2: case sensitivity citation.
 */
function extractSimpleStringEq(
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