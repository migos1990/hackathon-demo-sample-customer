/**
 * Attribute mapping between SCIM 2.0 (what Okta speaks) and BigCorpHR's
 * native LDAP-shaped API. Pure functions — no I/O, no state, trivially
 * testable.
 *
 * Source pattern: ldap (see docs/attribute-mapping-patterns.md Pattern 1)
 *
 * Mapping decisions:
 *   - BigCorpHR `uid` doubles as SCIM `id` AND `userName` (LDAP-backed
 *     SCIM convention — saves a secondary lookup table).
 *   - `cn` → `name.formatted`; fallback: compose from givenName + sn.
 *   - `sn: null` → omit `name.familyName` entirely (Madonna case) rather
 *     than emitting null, which some Okta consumers reject.
 *   - Enterprise extension emitted only when at least one of employeeNumber,
 *     department, title is non-null. Per okta-dialect.md §10: "don't claim
 *     capabilities you don't have" — same logic applies to extension URNs.
 *   - `lastModified` doubles as `meta.created` (BigCorpHR exposes no
 *     separate createdAt; conservative approximation per okta-dialect.md
 *     §11.6 open item on timestamp semantics).
 *
 * PATCH translation covers the OIN-gating subset per okta-dialect.md §1:
 *   - Shape A: unscoped replace `{op:"replace", value:{active:false}}`
 *   - Shape B: path replace `{op:"replace", path:"active", value:false}`
 *   - Shape C: path replace for name sub-attributes
 *   Unknown paths are silently no-oped (NOT thrown) because RFC 7644 §3.5.2
 *   atomicity requires all ops in a multi-op PATCH to succeed; ejecting on
 *   one unknown path would break the multi-op contract for everything else.
 *
 * Lifecycle policy: soft_delete (see ticket SCIM-LIVE-PROBE).
 *   PATCH active:false → set enabled:false, retain row.
 *   DELETE → same: set enabled:false, retain row.
 *   Per okta-dialect.md §3: Okta's deprovisioning signal IS `active:false`,
 *   not DELETE. Both paths must yield the same end-state.
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

// ─── SCIM → BigCorpHR (create) ────────────────────────────────────────────────

/**
 * Translate an incoming SCIM User POST body into BigCorpHR's create shape.
 *
 * Throws (not returns an error) on missing required fields: mapping failure
 * at this layer is a 400-class error that the store surfacing callers should
 * catch and map to a SCIM error envelope.
 */
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
      "SCIM emails[primary] is required — BigCorpHR requires a mail value",
    );
  }

  const givenName = scim.name?.givenName ?? "";
  const sn = scim.name?.familyName ?? null;
  const cn =
    scim.name?.formatted ?? composeCn(givenName, sn);

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
    // Default active:true when omitted — RFC 7643 §4.1.1: absence of `active`
    // means the user IS active.
    enabled: scim.active ?? true,
    memberOf: [],
  };
}

function pickPrimaryEmail(emails: ScimEmail[] | undefined): string | null {
  if (!emails || emails.length === 0) return null;
  const primary = emails.find((e) => e.primary === true);
  // If no entry is marked primary, fall back to first element rather than
  // rejecting the user (some SCIM clients omit the `primary` flag).
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

// ─── BigCorpHR → SCIM (read) ──────────────────────────────────────────────────

/**
 * Translate a BigCorpHR user record into a SCIM StoredUser.
 *
 * okta-dialect.md §10: include the enterprise URN in `schemas[]` only when
 * at least one enterprise field is non-null. Avoids advertising an empty
 * extension object to Okta, which can confuse attribute mapping UI.
 *
 * okta-dialect.md §11.6 (OPEN): emit timestamps without fractional seconds,
 * UTC Z suffix, per conservative default — `YYYY-MM-DDTHH:mm:ssZ`.
 */
export function bigCorpHrToScim(native: BigCorpHrUser): StoredUser {
  const schemas: string[] = [USER_CORE_SCHEMA];

  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;

  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // name — omit familyName entirely when sn is null (Madonna case).
  // Per okta-dialect.md §11 edge cases table: "Omit `name.familyName`; compose
  // `formatted` from givenName only."
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
      // Strip fractional seconds — okta-dialect.md §11.6 conservative default.
      lastModified: stripMillis(native.lastModified),
      // BigCorpHR does not expose a separate createdAt; approximate as
      // lastModified per okta-dialect.md §11.6 (open item).
      created: stripMillis(native.lastModified),
      location: `/scim/v2/Users/${native.uid}`,
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

/**
 * Normalise an ISO-8601 timestamp to `YYYY-MM-DDTHH:mm:ssZ`.
 * Strips fractional seconds. Converts +00:00 offset notation to Z.
 * Conservative per okta-dialect.md §11.6 (timestamp format is OPEN).
 */
function stripMillis(iso: string): string {
  // Replace ".NNN" fractional seconds with nothing, normalise +00:00 → Z.
  return iso
    .replace(/\.\d+Z$/, "Z")
    .replace(/\.\d+\+00:00$/, "Z")
    .replace(/\+00:00$/, "Z");
}

// ─── SCIM PATCH → BigCorpHR PATCH ────────────────────────────────────────────

/**
 * Translate SCIM PATCH operations into a BigCorpHR patch delta.
 *
 * Handles the four Okta-confirmed shapes from okta-dialect.md §1:
 *   - `replace` unscoped  → value object with multiple attrs
 *   - `replace` with path → single attr update
 *   - `add` unscoped/pathed → treated as replace for scalar attrs
 *   - `remove` with filter path → only `active` removal is meaningful here
 *     (BigCorpHR soft_delete policy); other remove ops are no-oped.
 *
 * RFC 7644 §3.5.2: ops applied sequentially (this loop is sequential).
 * Atomicity is delegated upward: the store applies the full translated patch
 * object in a single API call; if that call fails, nothing is persisted.
 *
 * Lifecycle policy: soft_delete (ticket SCIM-LIVE-PROBE).
 *   PATCH active:false → {enabled: false}. Row retained. Per okta-dialect.md §3.
 */
export function scimPatchToBigCorpHrPatch(
  ops: readonly ScimPatchOperation[],
): BigCorpHrUserPatch {
  const patch: BigCorpHrUserPatch = {};

  for (const op of ops) {
    const opLower = op.op.toLowerCase() as "add" | "remove" | "replace";

    if (opLower === "remove") {
      // The only remove that has a meaningful BigCorpHR translation is
      // removing `active` (which in soft_delete semantics = deactivate).
      // All other removes are no-oped.
      if (op.path && op.path.toLowerCase() === "active") {
        // Removing `active` = deactivate (soft_delete policy).
        patch.enabled = false;
      }
      continue;
    }

    // add + replace are handled identically for scalar fields.
    if (opLower !== "add" && opLower !== "replace") continue;

    if (!op.path) {
      // Shape A: unscoped — value is an object with attrs.
      applyValueObject(op.value, patch);
    } else {
      // Shape B/C: path-based.
      applyPathValue(op.path, op.value, patch);
    }
  }

  return patch;
}

function applyValueObject(value: unknown, patch: BigCorpHrUserPatch): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  // active — the deprovisioning signal. okta-dialect.md §4.
  if (typeof v["active"] === "boolean") patch.enabled = v["active"];

  // name sub-attributes via nested object (seen in unscoped replace shapes).
  if (typeof v["name"] === "object" && v["name"] !== null) {
    const n = v["name"] as Record<string, unknown>;
    if (typeof n["givenName"] === "string") patch.givenName = n["givenName"];
    if (typeof n["familyName"] === "string") patch.sn = n["familyName"];
    if (typeof n["formatted"] === "string") patch.cn = n["formatted"];
  }

  // Top-level scalars that Okta may include in a compound unscoped replace.
  if (typeof v["displayName"] === "string") patch.cn = v["displayName"];

  // Enterprise-extension fields may arrive in the flat PATCH value when
  // Okta sends an unscoped compound replace.
  // okta-dialect.md §11.6 (OPEN): which enterprise fields Okta actually
  // sends is admin-configurable; we handle the most common set defensively.
  const extKey = ENTERPRISE_SCHEMA;
  if (typeof v[extKey] === "object" && v[extKey] !== null) {
    const ext = v[extKey] as Record<string, unknown>;
    if (typeof ext["employeeNumber"] === "string")
      patch.employeeNumber = ext["employeeNumber"];
    if (typeof ext["department"] === "string")
      patch.department = ext["department"];
    if (typeof ext["title"] === "string") patch.title = ext["title"];
  }
}

function applyPathValue(
  path: string,
  value: unknown,
  patch: BigCorpHrUserPatch,
): void {
  // Normalise to lowercase for case-insensitive path matching.
  // RFC 7644 §3.4.2 attribute names are case-insensitive.
  const p = path.toLowerCase();

  switch (p) {
    case "active":
      if (typeof value === "boolean") patch.enabled = value;
      return;

    case "name.givenname":
    case "name.givenname":
      if (typeof value === "string") patch.givenName = value;
      return;

    case "name.familyname":
      if (typeof value === "string") patch.sn = value;
      return;

    case "name.formatted":
    case "displayname":
      if (typeof value === "string") patch.cn = value;
      return;

    case "title":
    case `${ENTERPRISE_SCHEMA.toLowerCase()}:title`:
      if (typeof value === "string") patch.title = value;
      return;

    case `${ENTERPRISE_SCHEMA.toLowerCase()}:employeenumber`:
      if (typeof value === "string") patch.employeeNumber = value;
      return;

    case `${ENTERPRISE_SCHEMA.toLowerCase()}:department`:
      if (typeof value === "string") patch.department = value;
      return;

    // Filter-path shapes for multi-valued attributes — e.g.
    // `emails[type eq "work"].value`. Okta uses these per okta-dialect.md §1
    // (Shape: replace with filter path). Map work email to `mail`.
    case `emails[type eq "work"].value`:
      if (typeof value === "string") patch.mail = value;
      return;

    default:
      // Unknown path — silent no-op. Do NOT throw here. RFC 7644 §3.5.2
      // atomicity: a single unknown path must not abort the whole multi-op
      // PATCH. The calling store will apply the accumulated delta; if the
      // delta is empty, the user is returned unchanged (200 with current body).
      return;
  }
}