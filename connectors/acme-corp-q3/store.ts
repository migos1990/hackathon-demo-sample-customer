/**
 * AcmeCorpQ3UserStore — adapts the skeleton's UserStore interface to
 * acme-corp-q3's LDAP-shaped Internal HR System API.
 *
 * Flow:
 *   1. SCIM request arrives on skeleton routes (skeleton/routes/users.ts)
 *   2. Skeleton calls this store's create / get / list / patch
 *   3. This store uses mapping.ts to translate SCIM ↔ native payloads
 *   4. This store uses client.ts to hit the Internal HR System API
 *   5. Native response is translated back to SCIM StoredUser for the route
 *
 * Additionally, this store is wired into the connector's custom DELETE route
 * (see server.ts) to implement the soft_delete lifecycle policy. The skeleton
 * UserStore interface does not define delete(); this store exposes softDelete()
 * directly so the connector's router can call it without breaking the interface.
 *
 * Dialect citations (Connector Law 3 DIALECT-CITED):
 *   - okta-dialect.md §2 — case-sensitive userName filter override (OIN step 16)
 *   - okta-dialect.md §3 — soft_delete lifecycle policy consistency
 *   - okta-dialect.md §7 — pagination: startIndex 1-based, treat 0 as 1
 *   - RFC 7644 §3.4.2.4  — totalResults required even when paged
 *   - RFC 7644 §3.5.2    — PATCH ops applied sequentially (mapping.ts)
 */

import { parse, filter as makePredicate } from "scim2-parse-filter";
import type { ScimPatchOperation } from "scim-patch";
import type { UserStore, ListOptions, ListResult } from "../../skeleton/store/user-store.js";
import { UserNameConflictError } from "../../skeleton/store/user-store.js";
import type { ScimUser, StoredUser } from "../../skeleton/types.js";
import type { AcmeCorpQ3Client } from "./client.js";
import { AcmeCorpQ3ApiError } from "./client.js";
import { scimToAcmeCorpQ3Create, acmeCorpQ3ToScim, scimPatchToAcmeCorpQ3Patch } from "./mapping.js";

export class AcmeCorpQ3UserStore implements UserStore {
  constructor(private readonly client: AcmeCorpQ3Client) {}

  /**
   * Liveness + reachability probe for /healthz (Connector Law 8 OBSERVABLE).
   * The skeleton's healthzRouter calls ping() when the method exists on the
   * injected store. Rejects if the HR system is unreachable.
   *
   * Uses listUsers() as a cheap HEAD-equivalent since the HR system does not
   * expose a dedicated /ping endpoint (documented in RUNBOOK.md limitations).
   */
  async ping(): Promise<void> {
    await this.client.listUsers();
  }

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    const nativeInput = scimToAcmeCorpQ3Create(input);
    try {
      const created = await this.client.createUser(nativeInput);
      return acmeCorpQ3ToScim(created);
    } catch (err) {
      if (err instanceof AcmeCorpQ3ApiError && err.status === 409) {
        // Translate target's uid conflict to skeleton's userName conflict.
        // The SCIM route maps UserNameConflictError → 409 + scimType:uniqueness
        // per RFC 7644 §3.12 and okta-dialect.md §8.
        throw new UserNameConflictError(nativeInput.uid);
      }
      throw err;
    }
  }

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user ? acmeCorpQ3ToScim(user) : null;
  }

  async list(options: ListOptions): Promise<ListResult> {
    // HR system has no server-side SCIM filter API — fetch all, filter
    // in-memory. For >10k user tenants, a filter-pushdown optimisation
    // should be added (documented in RUNBOOK.md limitations).
    const all = await this.client.listUsers();
    const scimUsers = all.map(acmeCorpQ3ToScim);

    let matched = scimUsers;

    if (options.filter !== undefined && options.filter.trim() !== "") {
      const ast = parse(options.filter);
      const predicate = makePredicate(ast);
      matched = scimUsers.filter(
        (u) => predicate(u as unknown as Record<string, unknown>),
      );

      // OIN test suite step 16 (Username Case Sensitivity Check) asserts that
      // `filter=userName eq "FOO"` returns a DIFFERENT result from
      // `filter=userName eq "foo"`. The scim2-parse-filter library matches
      // case-insensitively by default (RFC 7643 caseExact=false for userName).
      // We override to case-SENSITIVE for the simple `userName eq <literal>`
      // pattern to satisfy the OIN gate. See okta-dialect.md §2.
      const override = extractSimpleStringEqAttrAndValue(ast);
      if (override !== null && override.attr === "userName") {
        matched = matched.filter((u) => u.userName === override.value);
      }
    }

    const total = matched.length;

    // RFC 7644 §3.4.2.4: startIndex is 1-based. Treat 0 as 1
    // per okta-dialect.md §7.
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = matched.slice(from, from + options.count);

    return { resources: page, total };
  }

  async patch(id: string, operations: ScimPatchOperation[]): Promise<StoredUser | null> {
    const nativePatch = scimPatchToAcmeCorpQ3Patch(operations);
    const updated = await this.client.patchUser(id, nativePatch);
    return updated ? acmeCorpQ3ToScim(updated) : null;
  }

  /**
   * Soft-delete a user (lifecycle policy: soft_delete — OKT-60).
   *
   * NOT part of the skeleton UserStore interface. Called directly by the
   * connector's custom DELETE route in server.ts.
   *
   * Per okta-dialect.md §3: "DELETE handler and PATCH-active-false handler
   * MUST be policy-consistent." Both paths use client.softDeleteUser() which
   * PATCHes enabled=false on the target. The row is NEVER removed.
   *
   * Returns null when the user does not exist (SCIM route maps → 404).
   */
  async softDelete(id: string): Promise<StoredUser | null> {
    const updated = await this.client.softDeleteUser(id);
    return updated ? acmeCorpQ3ToScim(updated) : null;
  }
}

/**
 * AST inspector — if the top-level expression is a simple
 * `<attr> eq <stringLiteral>`, extract attr + value for the OIN step 16
 * case-sensitive override. Returns null for anything more complex.
 *
 * Duplicated from skeleton/store/user-store.ts (same rationale as
 * connectors/acme-hr/store.ts — a shared helper is post-hackathon scope).
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