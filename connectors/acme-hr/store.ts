/**
 * AcmeHrUserStore — adapts skeleton's UserStore interface to AcmeHR's
 * native LDAP-shaped API. This IS the connector: SCIM in (via skeleton
 * routes), AcmeHR out (via client + mapping).
 *
 * Flow (mirrors what the AI agent will generate for any customer target):
 *   1. SCIM request lands on skeleton routes (see skeleton/routes/users.ts)
 *   2. Skeleton calls this store's create/get/list/patch
 *   3. This store invokes `mapping.ts` to translate payloads
 *   4. This store invokes `client.ts` to hit AcmeHR's API
 *   5. Response translates AcmeHR → SCIM on the way back
 *
 * Filter + pagination for list() mirror skeleton/store/user-store.ts:176-207
 * (OIN-gating case-sensitive override for `userName eq`). Code is duplicated
 * intentionally — extracting a shared helper is post-hackathon scope.
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
import type { AcmeHrClient } from "./client.js";
import { AcmeHrApiError } from "./client.js";
import {
  scimToAcmeHrCreate,
  acmeHrToScim,
  scimPatchToAcmeHrPatch,
} from "./mapping.js";

export class AcmeHrUserStore implements UserStore {
  constructor(private readonly client: AcmeHrClient) {}

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    const acmeInput = scimToAcmeHrCreate(input);
    try {
      const created = await this.client.createUser(acmeInput);
      return acmeHrToScim(created);
    } catch (err) {
      if (err instanceof AcmeHrApiError && err.status === 409) {
        // Translate AcmeHR's uid conflict into skeleton's userName
        // conflict — the SCIM layer maps this to 409 + scimType:uniqueness
        // per RFC 7644 §3.12.
        throw new UserNameConflictError(acmeInput.uid);
      }
      throw err;
    }
  }

  async get(id: string): Promise<StoredUser | null> {
    const user = await this.client.getUser(id);
    return user ? acmeHrToScim(user) : null;
  }

  async list(options: ListOptions): Promise<ListResult> {
    // AcmeHR has no filter API — fetch all, filter in memory. This is the
    // pragmatic path for customer apps without server-side SCIM filter
    // support. Generated connectors for filter-capable targets should push
    // the filter down for efficiency.
    const all = await this.client.listUsers();
    const scimUsers = all.map(acmeHrToScim);

    let matched = scimUsers;
    if (options.filter !== undefined && options.filter.trim() !== "") {
      const ast = parse(options.filter);
      const predicate = makePredicate(ast);
      matched = scimUsers.filter((u) => predicate(u as unknown as Record<string, unknown>));

      // OIN step 16 — case-sensitive override for simple `userName eq <literal>`.
      // See skeleton/store/user-store.ts:185-199 for rationale.
      const override = extractSimpleStringEqAttrAndValue(ast);
      if (override && override.attr === "userName") {
        matched = matched.filter((u) => u.userName === override.value);
      }
    }

    const total = matched.length;
    // 1-based startIndex per RFC 7644 §3.4.2.4; treat 0 as 1.
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = matched.slice(from, from + options.count);

    return { resources: page, total };
  }

  async patch(id: string, operations: ScimPatchOperation[]): Promise<StoredUser | null> {
    const acmePatch = scimPatchToAcmeHrPatch(operations);
    const updated = await this.client.patchUser(id, acmePatch);
    return updated ? acmeHrToScim(updated) : null;
  }
}

/**
 * AST walker — if the top-level expr is `<attr> eq <stringLiteral>`, extract
 * attr + value; otherwise return null. Used for the OIN step 16 case-sensitive
 * override on simple userName queries. Duplicated from skeleton/store/
 * user-store.ts:54-66 — see header comment for rationale.
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
