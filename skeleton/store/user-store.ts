/**
 * In-memory reference UserStore for the skeleton. Generated per-customer
 * servers swap this for a real backing store (Postgres / LDAP proxy /
 * API fan-out). The UserStore interface is the contract.
 *
 * Behavioral decisions (testable via user-store.test.ts):
 *   - Server-generated ids are Okta-shaped opaque strings (20 chars total:
 *     "00u" + 17 random chars) per okta-dialect.md §11.5.
 *   - Duplicate userName throws — caller maps to 409 + scimType:uniqueness
 *     per RFC 7644 §3.12 and okta-dialect.md §8.
 *   - Filter matching is CASE-SENSITIVE by default (OIN test suite step 16
 *     explicitly asserts this — okta-dialect.md §2). A case-insensitive
 *     overlay wrapper lives outside this class; the customer's ticket
 *     template drives whether to wrap.
 *   - Lists return unpaginated total alongside the paginated resources
 *     per RFC 7644 §3.4.2.4.
 */
import { parse, filter as makePredicate } from "scim2-parse-filter";
import { scimPatch, type ScimPatchOperation, type ScimResource } from "scim-patch";
import { randomBytes } from "node:crypto";
import type { ScimUser, StoredUser } from "../types.js";

export interface ListOptions {
  startIndex: number;
  count: number;
  filter?: string;
}

export interface ListResult {
  resources: StoredUser[];
  total: number;
}

export interface UserStore {
  create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser>;
  get(id: string): Promise<StoredUser | null>;
  list(options: ListOptions): Promise<ListResult>;
  patch(id: string, operations: ScimPatchOperation[]): Promise<StoredUser | null>;
}

export class UserNameConflictError extends Error {
  constructor(userName: string) {
    super(`userName already exists: ${userName}`);
    this.name = "UserNameConflictError";
  }
}

/**
 * If the AST is a simple top-level `<attr> eq <stringLiteral>`, return the
 * attr path + literal value so the caller can do case-exact matching.
 * Returns null for anything else (logical compositions, filter-paths,
 * non-string comparisons, etc.) — those fall back to library semantics.
 *
 * This is an Okta-dialect override, not a general improvement.
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

function generateOktaShapedId(): string {
  // "00u" + 17 chars from a-zA-Z0-9 = 20 chars total, matching Okta's
  // opaque-ID shape. This is a skeleton convenience; real servers may use
  // UUIDs or customer-assigned IDs.
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(17);
  let s = "";
  for (let i = 0; i < 17; i++) {
    // randomBytes(17) returns exactly 17 bytes, but noUncheckedIndexedAccess
    // widens to possibly-undefined. Double-! to reach the char at the
    // computed alphabet index.
    const byte = bytes[i]!;
    const ch = alphabet[byte % alphabet.length]!;
    s += ch;
  }
  return "00u" + s;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); // drop millis per okta-dialect.md §11.6 conservative default
}

export class InMemoryUserStore implements UserStore {
  private readonly byId = new Map<string, StoredUser>();

  async create(input: Omit<ScimUser, "id" | "meta">): Promise<StoredUser> {
    // Uniqueness check on userName — case-sensitive per OIN default.
    const newUserName = input.userName;
    if (newUserName !== undefined) {
      for (const existing of this.byId.values()) {
        if (existing.userName === newUserName) {
          throw new UserNameConflictError(newUserName);
        }
      }
    }

    const id = generateOktaShapedId();
    const now = nowIso();
    const user: StoredUser = {
      ...input,
      id,
      meta: {
        resourceType: "User",
        created: now,
        lastModified: now,
        location: `/scim/v2/Users/${id}`,
      },
    };
    this.byId.set(id, user);
    return structuredClone(user);
  }

  async get(id: string): Promise<StoredUser | null> {
    const user = this.byId.get(id);
    return user ? structuredClone(user) : null;
  }

  /**
   * Apply PATCH operations atomically per RFC 7644 §3.5.2.
   *
   * Delegates the operation application to the scim-patch library
   * (see docs/integrations/scim-patch.md). We wrap it with:
   *   - 404 semantics (return null when id is missing)
   *   - userName uniqueness re-check after the patch (PATCH can update
   *     userName; we re-check against other rows before persisting)
   *   - meta.lastModified update on successful apply
   *   - structuredClone snapshots to avoid caller mutation leaking back
   *     into our Map (defensive for the in-memory implementation)
   *
   * Atomicity: if scim-patch throws on any op OR the uniqueness check
   * fails, we do NOT mutate our Map — the pre-patch state remains.
   */
  async patch(id: string, operations: ScimPatchOperation[]): Promise<StoredUser | null> {
    const existing = this.byId.get(id);
    if (existing === undefined) return null;

    // Work on a clone so a throw from scim-patch can't leave us partially applied.
    const draft = structuredClone(existing);

    // scim-patch's ScimResource type declares meta.created/lastModified as
    // Date, but RFC 7643 + Okta expect ISO 8601 strings on the wire (which
    // we store). The library does not read or mutate meta.* during patch
    // application (verified in node_modules/scim-patch/lib/src/types/types.d.ts:5
    // and node_modules/scim-patch/lib/src/scimPatch.d.ts:6 — generic T extends
    // ScimResource only constrains shape, not behavior). The cast is a
    // known-safe type lie. TRUTH LAW: UNVERIFIED behavior if library bump
    // ever starts touching meta during apply — covered by our patch tests
    // (they assert meta.lastModified changes only via OUR explicit write
    // below, not via scim-patch). Retest on library upgrade.
    scimPatch(draft as unknown as ScimResource, operations);

    // Post-patch uniqueness check: if userName changed, re-assert no collision.
    if (draft.userName !== undefined && draft.userName !== existing.userName) {
      for (const other of this.byId.values()) {
        if (other.id === id) continue;
        if (other.userName === draft.userName) {
          throw new UserNameConflictError(draft.userName);
        }
      }
    }

    draft.meta = {
      ...draft.meta,
      lastModified: nowIso(),
    };
    this.byId.set(id, draft);
    return structuredClone(draft);
  }

  async list(options: ListOptions): Promise<ListResult> {
    const all = Array.from(this.byId.values());

    let matched = all;
    if (options.filter !== undefined && options.filter.trim() !== "") {
      const ast = parse(options.filter);
      // scim2-parse-filter's `filter(ast)` returns a predicate fn for Array.filter.
      const predicate = makePredicate(ast);
      matched = all.filter((u) => predicate(u as unknown as Record<string, unknown>));

      // OIN test suite step 16 (Username Case Sensitivity Check) asserts that
      // `userName eq "FOO"` and `userName eq "foo"` return DIFFERENT results.
      // scim2-parse-filter follows RFC 7643's caseExact=false default for
      // userName and matches case-insensitively. For OIN acceptance we must
      // override to case-SENSITIVE on simple `userName eq <literal>` filters.
      // See okta-dialect.md §2. This override lives here (skeleton default);
      // a case-insensitive overlay wrapper is opt-in per customer ticket.
      const caseExactOverride = extractSimpleStringEqAttrAndValue(ast);
      if (caseExactOverride && caseExactOverride.attr === "userName") {
        matched = matched.filter((u) => u.userName === caseExactOverride.value);
      }
    }

    const total = matched.length;
    // RFC 7644 §3.4.2.4: startIndex is 1-based. Treat 0 as 1 per okta-dialect §7.
    const startIndex = Math.max(1, options.startIndex);
    const from = startIndex - 1;
    const page = matched.slice(from, from + options.count);

    return {
      resources: page.map((u) => structuredClone(u)),
      total,
    };
  }
}
