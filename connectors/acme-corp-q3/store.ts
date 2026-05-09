/**
 * AcmeCorpQ3UserStore — adapts the skeleton's UserStore interface to the
 * Acme Corp Q3 HR API via client.ts + mapping.ts.
 *
 * This IS the connector: SCIM in (via skeleton routes), HR API out (via
 * client + mapping). Follows the same architecture as
 * connectors/acme-hr/store.ts.
 *
 * Lifecycle policy: soft_delete (ticket OKT-54).
 *   - PATCH active:false → client.patchUser({enabled: false}) — row retained.
 *   - DELETE (if Okta ever calls it, which per okta-dialect.md §3 it won't
 *     in normal flow) → also maps to {enabled: false} to enforce the soft_delete
 *     policy rather than hard-deleting. The delete() method exists to satisfy
 *     required_ops.users_delete:true but preserves the policy contract.
 *
 * Filter + pagination: HR API has no server-side filter — fetch all, filter
 * in memory (same pattern as connectors/acme-hr/store.ts). See limitation
 * note in RUNBOOK.md.
 *
 * Case-sensitive userName filter override (OIN test suite step 16):
 * scim2-parse-filter matches case-insensitively by default; we override to
 * case-SENSITIVE for simple `userName eq <literal>` to pass the OIN gate.
 * See okta-dialect.md §2 (Case sensitivity — THE Okta quirk) and
 * skeleton/store/user-store.ts for the same pattern with detailed comments.
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
import type { AcmeCorpQ3Client } from "./client.js";
import { AcmeCorpQ3ApiError } from "./client.js";
import {
  scimToAcmeCorpQ3Create,
  acmeCorpQ3ToScim,
  scimPatchToAcmeCorpQ3Patch,
} from "./mapping.js";

export class AcmeCorpQ3UserStore implements UserStore {
  constructor(private readonly client: AcmeCorpQ3Client) {}

  // ── Health probe (Connector Law 8 OBSERVABLE) ──────────────────────────────

  /**
   * Cheap reachability probe for /healthz. Called by the skeleton's
   * healthzRouter when it detects a `ping` method on the store.
   * Rejects if the HR API is unreachable.
   *
   * For customer apps where listUsers is expensive, replace with a
   * cheaper HEAD / or dedicated /ping endpoint.
   */
  async ping(): Promise<void> {
    await this.client.listUsers();
  }

  // ── UserStore: create ──────────────────────────────────────────────────────

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    const nativeInput = scimToAcmeCorpQ3Create(input);
    try {
      const created = await this.client.createUser(nativeInput);
      return acmeCorpQ3ToScim(created);
    } catch (err) {
      if (err instanceof AcmeCorpQ3ApiError && err.status === 409) {
        // Translate HR API's uid conflict to skeleton's UserNameConflictError.
        // The SCIM route maps this to 409 + scimType:uniqueness per RFC 7644
        // §3.12 and okta-dialect.md §8. OIN test suite step 14 verifies this.
        throw new UserNameConflictError(nativeInput.uid);
      }
      throw err;
    }
  }

  // ── UserStore: get ─────────────────────────────────────────────────────────

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user ? acmeCorpQ3ToScim(user) : null;
  }

  // ── UserStore: list ────────────────────────────────────────────────────────

  async list(options: ListOptions): Promise<ListResult> {
    // HR API has no filter endpoint — fetch all, filter client-side.
    // Limitation documented in RUNBOOK.md §Known limitations.
    const all = await this.client.listUsers();
    const scimUsers = all.map(acmeCorpQ3ToScim);

    let matched = scimUsers;

    if (options.filter !== undefined && options.filter.trim() !== "") {
      const ast = parse(options.filter);
      const predicate = makePredicate(ast);
      matched = scimUsers.filter(
        (u) => predicate(u as unknown as Record<string, unknown>),
      );

      // OIN test suite step 16: userName eq filter must be CASE-SENSITIVE.
      // scim2-parse-filter's default is case-insensitive (RFC 7643 caseExact=false).
      // Override: re-filter with strict equality for simple `userName eq <literal>`.
      // See okta-dialect.md §2 (Case sensitivity) + skeleton/store/user-store.ts.
      const caseOverride = extractSimpleStringEqAttrAndValue(ast);
      if (caseOverride?.attr === "userName") {
        matched = matched.filter((u) => u.userName === caseOverride.value);
      }
    }

    const total = matched.length;
    // RFC 7644 §3.4.2.4: startIndex is 1-based; treat 0 as 1 (okta-dialect.md §7).
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = matched.slice(from, from + options.count);

    return { resources: page, total };
  }

  // ── UserStore: patch ───────────────────────────────────────────────────────

  async patch(
    id: string,
    operations: ScimPatchOperation[],
  ): Promise<StoredUser | null> {
    // mapping.ts translates SCIM PatchOp → AcmeCorpQ3UserPatch.
    // For soft_delete lifecycle: PATCH active:false → {enabled:false}.
    // See okta-dialect.md §3 and §4 + mapping.ts scimPatchToAcmeCorpQ3Patch.
    const nativePatch = scimPatchToAcmeCorpQ3Patch(operations);

    // If the patch is empty after translation (e.g. all ops were unknown paths),
    // short-circuit to a GET so the route can return the current resource body.
    // This keeps PATCH idempotent per okta-dialect.md §1 (Anti-patterns).
    if (Object.keys(nativePatch).length === 0) {
      return this.get(id);
    }

    const updated = await this.client.patchUser(id, nativePatch);
    return updated ? acmeCorpQ3ToScim(updated) : null;
  }

  // ── delete — soft_delete policy enforcement ────────────────────────────────

  /**
   * Handles Okta's DELETE signal (if ever called) by mapping to a soft
   * deactivation rather than a hard delete.
   *
   * Per okta-dialect.md §3: "Okta does NOT use DELETE /Users/{id} at all
   * in the standard lifecycle." Ticket OKT-54 requires users_delete:true,
   * so the interface method exists — but we enforce soft_delete policy by
   * translating any DELETE call to {enabled: false}.
   *
   * This ensures consistency between the DELETE and PATCH paths as required
   * by okta-dialect.md §3 ("DELETE handler and PATCH-active-false handler
   * MUST be policy-consistent").
   *
   * NOTE: this method is NOT part of the standard UserStore interface
   * (skeleton/store/user-store.ts). It is called from the DELETE route
   * added in server.ts. If the standard interface is extended later to
   * include delete(), this implementation satisfies it.
   */
  async delete(id: string): Promise<boolean> {
    // soft_delete: translate DELETE → PATCH {enabled: false} on the target.
    // Never call client.deleteUser() — rows must be retained for audit.
    const updated = await this.client.patchUser(id, { enabled: false });
    // null means 404 (user not found); true means successfully deactivated.
    return updated !== null;
  }
}

// ─── Private helpers ─────────────────────────────────────────────────────────

/**
 * If the filter AST is a simple top-level `<attr> eq <stringLiteral>`,
 * extract attr + value for the OIN step 16 case-sensitive override.
 * Returns null for all other filter shapes (logical AND/OR, complex paths,
 * non-string comparisons) — those fall through to library semantics.
 *
 * Duplicated from skeleton/store/user-store.ts (same rationale as
 * connectors/acme-hr/store.ts — extraction deferred post-hackathon).
 * See okta-dialect.md §2.
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