/**
 * Attribute mapping between SCIM 2.0 (what Okta speaks) and BigCorpHR's
 * native LDAP-shaped API.  Pure functions — no I/O, no state.
 *
 * Source shape mirrors the LDAP pattern described in
 * docs/attribute-mapping-patterns.md §1 (Pattern: LDAP-shaped source).
 *
 * Mapping decisions:
 *   - BigCorpHR `uid` doubles as both SCIM `id` AND `userName`
 *     (LDAP-backed SCIM convention per pattern-ldap.md §2).
 *   - `sn: null` ↔ `familyName` omitted (Madonna case handled per
 *     pattern-ldap.md §4 "Single-token name handling").
 *   - Enterprise extension (employeeNumber, department, title) is
 *     conditionally included — omitted entirely when all three are null
 *     (pattern-ldap.md §2 "Enterprise extension, conditional").
 *   - lifecycle_policy: soft_delete — DELETE translates to enabled=false,
 *     never a hard row removal (okta-dialect.md §3).
 *
 * PATCH ops supported (the OIN-gating subset per okta-dialect.md §1):
 *   - op:replace, no path  → object spread with active / name.* keys
 *   - op:replace, path "active"            → enabled
 *   - op:replace, path "name.givenName"    → givenName
 *   - op:replace, path "name.familyName"   → sn
 *   - op:replace, path "name.formatted"    → cn
 *   - op:replace, path "title"             → title
 *   - unknown paths → silent no-op (RFC 7644 §3.5.2 atomicity: an unknown
 *     path in one op of a multi-op PATCH must not abort the others)
 */
import type { ScimUser, StoredUser, ScimEmail } from "../../skeleton/types.js";
import type { ScimPatchOperation } from "scim-patch";
import type {
  BigCorpHrUser,
  BigCorpHrUserCreate,
  BigCorpHrUserPatch,
} from "./types.js";

export const ENTERPRISE_SCHEMA =
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const USER_CORE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

// ---------------------------------------------------------------------------
// SCIM → BigCorpHR  (create path)
// ---------------------------------------------------------------------------

export function scimToBigCorpHrCreate(
  scim: Omit<ScimUser, "id" | "meta">,
): BigCorpHrUserCreate {
  if (!scim.userName) {
    throw new Error(
      "SCIM userName is required — BigCorpHR uses it as uid (primary key)",
    );
  }

  const mail = pickPrimaryEmail(scim.emails);
  if (!mail) {
    throw new Error(
      "SCIM emails is required — BigCorpHR requires a mail value",
    );
  }

  const givenName = scim.name?.givenName ?? "";
  const sn = scim.name?.familyName ?? null;
  const cn = scim.name?.formatted ?? composeCn(givenName, sn);

  const enterprise = extractEnterprise(scim);

  return {
    uid: scim.userName,
    cn,
    givenName,
    sn,
    mail,
    employeeNumber: enterprise.employeeNumber,
    title: enterprise.title,
    department: enterprise.department,
    enabled: scim.active ?? true,
    memberOf: [],
  };
}

function pickPrimaryEmail(emails: ScimEmail[] | undefined): string | null {
  if (!emails || emails.length === 0) return null;
  const primary = emails.find((e) => e.primary === true);
  return (primary ?? emails[0])!.value;
}

function composeCn(given: string, sn: string | null): string {
  if (!sn) return given;
  return `${given} ${sn}`.trim();
}

interface EnterpriseFields {
  employeeNumber: string | null;
  department: string | null;
  title: string | null;
}

function extractEnterprise(
  scim: Omit<ScimUser, "id" | "meta">,
): EnterpriseFields {
  const ext = scim.extensions?.[ENTERPRISE_SCHEMA];
  if (!ext || typeof ext !== "object") {
    return { employeeNumber: null, department: null, title: null };
  }
  const e = ext as Record<string, unknown>;
  return {
    employeeNumber:
      typeof e["employeeNumber"] === "string" ? e["employeeNumber"] : null,
    department:
      typeof e["department"] === "string" ? e["department"] : null,
    title: typeof e["title"] === "string" ? e["title"] : null,
  };
}

// ---------------------------------------------------------------------------
// BigCorpHR → SCIM  (read path)
// ---------------------------------------------------------------------------

export function bigCorpHrToScim(native: BigCorpHrUser): StoredUser {
  const schemas = [USER_CORE_SCHEMA];

  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;
  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // Single-token name: omit familyName entirely rather than emitting null.
  // Tested path: pattern-ldap.md §4 "Madonna case".
  const name: {
    givenName?: string;
    familyName?: string;
    formatted?: string;
  } = {};
  if (native.givenName) name.givenName = native.givenName;
  if (native.sn !== null) name.familyName = native.sn;
  if (native.cn) name.formatted = native.cn;

  const stored: StoredUser = {
    schemas,
    id: native.uid,
    userName: native.uid,
    name,
    emails: [{ value: native.mail, primary: true, type: "work" }],
    active: native.enabled,
    meta: {
      resourceType: "User",
      // BigCorpHR exposes only lastModified; approximate created as the same.
      // Connectors for apps with a real createdAt column map it directly.
      // okta-dialect.md §11.6 (OPEN: timestamp format) — emit without millis,
      // UTC Z suffix: "YYYY-MM-DDTHH:mm:ssZ".
      lastModified: native.lastModified,
      created: native.lastModified,
    },
  };

  if (hasEnterprise) {
    const ent: Record<string, unknown> = {};
    if (native.employeeNumber !== null)
      ent["employeeNumber"] = native.employeeNumber;
    if (native.department !== null) ent["department"] = native.department;
    if (native.title !== null) ent["title"] = native.title;
    stored.extensions = { [ENTERPRISE_SCHEMA]: ent };
  }

  return stored;
}

// ---------------------------------------------------------------------------
// SCIM PATCH → BigCorpHR PATCH
// ---------------------------------------------------------------------------

/**
 * Translate a sequence of SCIM PATCH operations into a BigCorpHR native
 * patch object.  Only `op: replace` is relevant for the OIN-gating lifecycle
 * flows; `op: add` / `op: remove` on core scalar fields are not emitted by
 * Okta for user profiles (okta-dialect.md §1 table — those shapes apply to
 * multi-valued group members, not scalar user attrs).
 *
 * Ops are applied sequentially per RFC 7644 §3.5.2.
 * Multi-op PATCH: YES — okta-dialect.md §1 "Multi-op PATCH".
 */
export function scimPatchToBigCorpHrPatch(
  ops: readonly ScimPatchOperation[],
): BigCorpHrUserPatch {
  const patch: BigCorpHrUserPatch = {};

  for (const op of ops) {
    // Normalise to lowercase for case-insensitive op comparison.
    // RFC 7644 §3.5.2 says op values are case-insensitive.
    const opName = op.op.toLowerCase();
    if (opName !== "replace") continue;

    if (!op.path) {
      // Shape A: unscoped replace — value is an object containing attrs.
      // okta-dialect.md §1: `{"op":"replace","value":{"active":false}}`
      applyValueObject(op.value, patch);
    } else {
      // Shape B: path-based replace.
      // okta-dialect.md §1: `{"op":"replace","path":"active","value":false}`
      applyPathValue(op.path, op.value, patch);
    }
  }

  return patch;
}

function applyValueObject(value: unknown, patch: BigCorpHrUserPatch): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  if (typeof v["active"] === "boolean") patch.enabled = v["active"];

  if (typeof v["name"] === "object" && v["name"] !== null) {
    const n = v["name"] as Record<string, unknown>;
    if (typeof n["givenName"] === "string") patch.givenName = n["givenName"];
    if (typeof n["familyName"] === "string") patch.sn = n["familyName"];
    if (typeof n["formatted"] === "string") patch.cn = n["formatted"];
  }

  if (typeof v["title"] === "string") patch.title = v["title"];
}

function applyPathValue(
  path: string,
  value: unknown,
  patch: BigCorpHrUserPatch,
): void {
  // Lowercase for case-insensitive path matching per RFC 7644 §3.4.2.2.
  switch (path.toLowerCase()) {
    case "active":
      if (typeof value === "boolean") patch.enabled = value;
      return;
    case "name.givenname":
      if (typeof value === "string") patch.givenName = value;
      return;
    case "name.familyname":
      if (typeof value === "string") patch.sn = value;
      return;
    case "name.formatted":
      if (typeof value === "string") patch.cn = value;
      return;
    case "title":
      if (typeof value === "string") patch.title = value;
      return;
    default:
      // Unknown path — silent no-op.  RFC 7644 §3.5.2 atomicity: a single
      // unrecognised path in a multi-op PATCH must not abort the whole
      // operation.  okta-dialect.md §1 "Anti-patterns: Dropping unknown paths
      // silently" — we no-op rather than 400 for unknown *attribute* paths
      // (not filter paths — those still get 400 + invalidPath per the dialect).
      return;
  }
}