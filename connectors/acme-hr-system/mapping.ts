/**
 * Attribute mapping between SCIM 2.0 (what Okta speaks) and Acme HR
 * System's native LDAP-shaped API.  Pure functions — no I/O, no state,
 * trivially testable.
 *
 * Ticket: OKT-10  customer_slug: acme-hr-system
 *
 * Mapping decisions (see docs/patterns/ldap.md for full rationale):
 *
 *   uid ↔ SCIM id + userName
 *     LDAP-backed SCIM convention: the native primary key doubles as both
 *     the SCIM resource id and the userName. Avoids a separate id-lookup
 *     table and keeps filter-by-userName → get-by-id round-trips stable.
 *
 *   sn nullable → name.familyName omitted
 *     Single-token names (the "Madonna case") set sn=null. We omit
 *     name.familyName rather than emitting null — some Okta consumers
 *     reject null family names. docs/patterns/ldap.md §4.
 *
 *   mail → emails[{primary:true,type:"work"}]
 *     LDAP mail is scalar; SCIM multi-value wrapper is applied here.
 *
 *   Enterprise extension: conditional
 *     Emitted only when at least one of employeeNumber/department/title is
 *     non-null. Emitting the schema URN for an empty extension confuses some
 *     Okta attribute-mapping configs. docs/patterns/ldap.md §3.
 *
 *   PATCH translation (scimPatchToNativePatch):
 *     Handles the four shapes Okta emits per okta-dialect.md §1:
 *       • replace with no path   → value object with multiple attrs
 *       • replace path "active"  → enabled boolean (deactivation flow)
 *       • replace path "name.*"  → name fields
 *       • other replace paths    → silent no-op (unknown paths are NOT
 *         thrown; throwing would abort atomic multi-op PATCHes containing
 *         recognised ops — RFC 7644 §3.5.2).
 *     add / remove ops are silently skipped (not required by OKT-10 scope).
 *
 * Citations:
 *   okta-dialect.md §1  (PATCH shapes)
 *   okta-dialect.md §3  (soft delete / active: false semantics)
 *   okta-dialect.md §6  (attribute deprovisioning — NOT required by OKT-10)
 *   RFC 7643 §4.1.1     (active, userName required)
 *   RFC 7644 §3.5.2     (PATCH atomicity — sequential ops)
 */

import type { ScimUser, StoredUser, ScimEmail } from "../../skeleton/types.js";
import type { ScimPatchOperation } from "scim-patch";
import type {
  AcmeHrSystemUser,
  AcmeHrSystemUserCreate,
  AcmeHrSystemUserPatch,
} from "./types.js";

// ---------------------------------------------------------------------------
// Schema constants
// ---------------------------------------------------------------------------

export const ENTERPRISE_SCHEMA =
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const USER_CORE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

// ---------------------------------------------------------------------------
// SCIM → Native (create)
// ---------------------------------------------------------------------------

/**
 * Transform a SCIM User create-body into the shape required by
 * Acme HR System's POST /users endpoint.
 *
 * Throws on missing required fields (userName, mail) so the SCIM route can
 * surface a 400 before hitting the target API.
 */
export function scimToNativeCreate(
  scim: Omit<ScimUser, "id" | "meta">,
): AcmeHrSystemUserCreate {
  // userName required — RFC 7643 §4.1.1; also the LDAP primary key.
  if (!scim.userName) {
    throw new Error(
      "SCIM userName is required — Acme HR System uses it as uid (primary key)",
    );
  }

  const mail = pickPrimaryEmail(scim.emails);
  if (!mail) {
    throw new Error(
      "SCIM emails is required — Acme HR System requires a mail value",
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
    // active defaults to true when not supplied — RFC 7643 §4.1.1.
    // okta-dialect.md §4: absence of `active` means active.
    enabled: scim.active ?? true,
    memberOf: [],
  };
}

// ---------------------------------------------------------------------------
// Native → SCIM (read)
// ---------------------------------------------------------------------------

/**
 * Transform an Acme HR System user record into the SCIM StoredUser shape
 * returned to Okta.
 *
 * Enterprise extension is included only when at least one enterprise field
 * is non-null (okta-dialect.md §10 / docs/patterns/ldap.md §3).
 *
 * meta.created is approximated from lastModified because Acme HR System does
 * not expose a separate creation timestamp. Real customers with a `createdAt`
 * column should map it directly.
 */
export function nativeToScim(native: AcmeHrSystemUser): StoredUser {
  const schemas = [USER_CORE_SCHEMA];

  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;
  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // name object — omit familyName when sn is null (Madonna case).
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
    // okta-dialect.md §3: soft_delete policy — enabled false → active false.
    active: native.enabled,
    meta: {
      resourceType: "User",
      // okta-dialect.md §11.6: emit YYYY-MM-DDTHH:mm:ssZ (no fractional
      // seconds, UTC Z) for conservative interoperability.
      lastModified: normaliseTimestamp(native.lastModified),
      created: normaliseTimestamp(native.lastModified),
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

// ---------------------------------------------------------------------------
// SCIM PATCH → Native PATCH
// ---------------------------------------------------------------------------

/**
 * Translate a sequence of SCIM PatchOperations into an Acme HR System
 * patch object.
 *
 * Handles the four PATCH shapes Okta emits per okta-dialect.md §1:
 *   1. replace, no path  → value is a multi-attr object
 *   2. replace, path "active"
 *   3. replace, path "name.*"
 *   4. replace, other paths → silent no-op (see header comment)
 *
 * add/remove ops are silently skipped; they are not in OKT-10 scope
 * (group push not enabled).
 *
 * RFC 7644 §3.5.2: ops are applied sequentially, not in parallel.
 * okta-dialect.md §1: multi-op PATCH is supported; single endpoint handles both.
 */
export function scimPatchToNativePatch(
  ops: readonly ScimPatchOperation[],
): AcmeHrSystemUserPatch {
  const patch: AcmeHrSystemUserPatch = {};

  for (const op of ops) {
    // Only replace is handled for OKT-10 scope.
    if (op.op !== "replace" && op.op !== "Replace") continue;

    if (!op.path) {
      // Case A: no path — value is a multi-attr object (most common for
      // deactivation: {active: false}). okta-dialect.md §1.
      applyValueObject(op.value, patch);
    } else {
      // Case B: path-based replace.
      applyPathValue(op.path, op.value, patch);
    }
  }

  return patch;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

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

function applyValueObject(
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  // Deactivation: {active: false} — okta-dialect.md §3 soft_delete.
  if (typeof v["active"] === "boolean") patch.enabled = v["active"];

  // Name fields may arrive as a nested object in the unscoped replace form.
  if (typeof v["name"] === "object" && v["name"] !== null) {
    const n = v["name"] as Record<string, unknown>;
    if (typeof n["givenName"] === "string") patch.givenName = n["givenName"];
    if (typeof n["familyName"] === "string") patch.sn = n["familyName"];
    if (typeof n["formatted"] === "string") patch.cn = n["formatted"];
  }

  // Flat name.* variants also appear at root level in some Okta flows.
  if (typeof v["name.givenName"] === "string")
    patch.givenName = v["name.givenName"] as string;
  if (typeof v["name.familyName"] === "string")
    patch.sn = v["name.familyName"] as string;

  if (typeof v["title"] === "string") patch.title = v["title"];
  if (typeof v["department"] === "string") patch.department = v["department"];
}

function applyPathValue(
  path: string,
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  // Normalise to lowercase for case-insensitive path matching.
  // okta-dialect.md §1: Okta path capitalisation can vary.
  const normalised = path.toLowerCase();

  switch (normalised) {
    case "active":
      // okta-dialect.md §3: deactivation signal. lifecycle_policy=soft_delete
      // means we set enabled=false, never delete the row.
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

    case "department":
      if (typeof value === "string") patch.department = value;
      return;

    case "employeenumber": {
      // Enterprise extension path may arrive as
      // "urn:...:enterprise:2.0:User:employeeNumber" or just "employeeNumber".
      if (typeof value === "string") patch.employeeNumber = value;
      return;
    }

    default:
      // Unknown or unsupported path — silent no-op.
      // RFC 7644 §3.5.2: throwing here would abort a multi-op PATCH that
      // also contains recognised ops. Callers should not assume failure.
      return;
  }
}

/**
 * Normalise an ISO-8601 timestamp to YYYY-MM-DDTHH:mm:ssZ (no fractional
 * seconds, UTC Z-suffix). Conservative default per okta-dialect.md §11.6.
 */
function normaliseTimestamp(ts: string): string {
  try {
    return new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");
  } catch {
    // If the source emits a malformed timestamp, return it as-is rather than
    // crashing — the connector should not fail a read because of a bad ts.
    return ts;
  }
}