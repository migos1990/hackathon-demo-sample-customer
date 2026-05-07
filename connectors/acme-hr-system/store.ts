/**
 * AcmeHrSystemUserStore — adapts the skeleton's UserStore interface to the
 * Acme HR System's native LDAP-shaped REST API.
 *
 * This is the connector core: SCIM in (via skeleton routes), Acme HR out
 * (via client + mapping).
 *
 * Flow:
 *   1. SCIM request lands on skeleton/routes/users.ts
 *   2. Skeleton calls this store's create / get / list / patch / delete
 *   3. This store translates payloads via mapping.ts
 *   4. This store hits the target API via client.ts
 *   5. Target response is translated back to SCIM via mapping.ts
 *
 * Lifecycle policy: soft_delete (OKT-10).
 *   - PATCH active=false  → patchUser({enabled:false}) — retains the row.
 *   - DELETE /Users/:id   → patchUser({enabled:false}) — same end-state,
 *     NOT a hard delete. Okta does NOT normally issue DELETE in the standard
 *     deprovision flow (okta-dialect.md §3 — "Okta does NOT use DELETE
 *     /Users/{id} at all in the standard lifecycle"). We implement it here
 *     because `required_ops.users_delete: true` is set in OKT-10, and our
 *     policy-consistent implementation is: DELETE = soft-disable, never wipe.
 *
 * Filter + pagination: the Acme HR System has no server-side filter API.
 * We fetch all users and filter in-memory, same as the reference connector
 * (connectors/acme-hr/store.ts). The OIN-gating case-sensitive override for
 * `userName eq <literal>` is applied here per okta-dialect.md §2 and OIN
 * test suite step 16.
 *
 * Observability: ping() probes target reachability for /healthz
 * (Connector Law 8 OBSERVABLE).
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

/**
 * Extended UserStore interface with soft-delete and health-probe methods.
 * The skeleton's healthzRouter duck-types for `ping`; the users router
 * duck-types for `softDelete` when present (falls back to 405 if absent).
 */
export interface AcmeHrSystemUserStoreInterface extends UserStore {
  ping(): Promise<void>;
  softDelete(id: string): Promise<boolean>;
}

export class AcmeHrSystemUserStore implements AcmeHrSystemUserStoreInterface {
  constructor(private readonly client: AcmeHrSystemClient) {}

  /**
   * Health probe for /healthz (Connector Law 8 OBSERVABLE).
   * Calls listUsers — cheap on AcmeHR-lite, acceptable for a probe.
   * Replace with a dedicated /ping or HEAD / call if listUsers is expensive
   * on the real target.
   */
  async ping(): Promise<void> {
    await this.client.listUsers();
  }

  // ─── UserStore: create ───────────────────────────────────────────────

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    const nativeInput = scimToAcmeHrSystemCreate(input);
    try {
      const created = await this.client.createUser(nativeInput);
      return acmeHrSystemToScim(created);
    } catch (err) {
      if (err instanceof AcmeHrSystemApiError && err.status === 409) {
        // Target returned 409 (uid collision) → translate to skeleton's
        // UserNameConflictError so the SCIM route maps it to
        // 409 + scimType:uniqueness per RFC 7644 §3.12 and okta-dialect.md §8.
        throw new UserNameConflictError(nativeInput.uid);
      }
      throw err;
    }
  }

  // ─── UserStore: get ──────────────────────────────────────────────────

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user ? acmeHrSystemToScim(user) : null;
  }

  // ─── UserStore: list ─────────────────────────────────────────────────

  /**
   * List with in-memory filter + pagination.
   *
   * No server-side filter API on Acme HR System → fetch all + filter locally.
   * For tenants with large user directories consider adding a
   * `GET /users?uid=<value>` lookup path if the target supports it.
   *
   * OIN test suite step 16 (Username Case Sensitivity Check):
   * scim2-parse-filter matches userName case-insensitively by default.
   * We override to case-SENSITIVE for simple `userName eq <literal>` filters
   * per okta-dialect.md §2. See extractSimpleEqOverride() below.
   */
  async list(options: ListOptions): Promise<ListResult> {
    const all = await this.client.listUsers();
    const scimUsers = all.map(acmeHrSystemToScim);

    let matched = scimUsers;
    if (options.filter !== undefined && options.filter.trim() !== "") {
      const ast = parse(options.filter);
      const predicate = makePredicate(ast);
      matched = scimUsers.filter((u) =>
        predicate(u as unknown as Record<string, unknown>),
      );

      // OIN step 16 case-sensitive override for `userName eq <literal>`.
      // See okta-dialect.md §2: "Okta's spec test expects CASE-SENSITIVE matching".
      const override = extractSimpleEqOverride(ast);
      if (override && override.attr === "userName") {
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

  // ─── UserStore: patch ────────────────────────────────────────────────

  /**
   * Apply SCIM PATCH operations.
   *
   * The scim-patch library handles RFC 7644 §3.5.2 atomicity on the SCIM
   * object model (applied in the skeleton's InMemoryUserStore before this
   * is called). Here we translate the final desired state to a native patch
   * and push it to the target.
   *
   * Deactivation (active=false) resolves to {enabled:false} via the mapping —
   * soft_delete policy: row is never removed (okta-dialect.md §3 + §4).
   */
  async patch(
    id: string,
    operations: ScimPatchOperation[],
  ): Promise<StoredUser | null> {
    const nativePatch = scimPatchToAcmeHrSystemPatch(operations);

    // If the patch resolves to an empty object (e.g. all no-op paths) we
    // still call getUser to return the current state, avoiding a spurious
    // 200 with a stale body.
    if (Object.keys(nativePatch).length === 0) {
      return this.get(id);
    }

    const updated = await this.client.patchUser(id, nativePatch);
    return updated ? acmeHrSystemToScim(updated) : null;
  }

  // ─── Soft-delete (policy-consistent DELETE handler) ──────────────────

  /**
   * Soft-delete: sets enabled=false on the target row.
   *
   * Called by the DELETE /Users/:id handler. Returns true if the user
   * existed and was disabled; false if the user was not found (caller
   * maps false → 404).
   *
   * Lifecycle policy = soft_delete (OKT-10): this MUST NOT call
   * client.deleteUser(). okta-dialect.md §3: "DELETE handler and
   * PATCH-active-false handler MUST be policy-consistent. Tests assert
   * both paths produce the same end-state for the same policy."
   */
  async softDelete(id: string): Promise<boolean> {
    const updated = await this.client.patchUser(id, { enabled: false });
    return updated !== null;
  }
}

/**
 * AST walker: if the expression is a simple top-level `<attr> eq <string>`,
 * return attr + value. Otherwise return null (falls back to library semantics).
 *
 * Used for the OIN step 16 case-sensitive override on `userName eq <literal>`.
 * Duplicated from skeleton/store/user-store.ts:54-66 — same rationale applies
 * here; factoring into a shared helper is post-hackathon scope.
 *
 * See okta-dialect.md §2 (Filter expression patterns — Case sensitivity).
 */
function extractSimpleEqOverride(
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