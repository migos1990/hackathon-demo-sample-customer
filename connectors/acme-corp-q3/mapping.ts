/**
 * Attribute mapping between SCIM 2.0 (what Okta speaks) and the
 * acme-corp-q3 Internal HR System's LDAP-shaped native API.
 *
 * Pure functions — no I/O, no state, trivially testable.
 *
 * Source pattern: docs/patterns/ldap.md
 * Okta dialect citations inline per Connector Law 3 (DIALECT-CITED).
 *
 * Mapping decisions:
 *   - `uid` doubles as SCIM `id` AND `userName` (LDAP-backed SCIM convention;
 *     docs/patterns/ldap.md §2 "uid doubles as both SCIM id AND userName").
 *   - `sn: null` ↔ `familyName: undefined` (the "Madonna case" —
 *     docs/patterns/ldap.md §4 single-token name handling).
 *   - Enterprise extension only emitted when at least one field is non-null
 *     (docs/patterns/ldap.md §2 "Enterprise extension, conditional").
 *   - PATCH ops support: root-level replace with value-object AND path-based
 *     replace for the OIN-gating subset (okta-dialect.md §1 Table).
 *   - Lifecycle policy "soft_delete" (OKT-60): active=false → enabled=false,
 *     row retained. Per okta-dialect.md §3 Table row "Soft delete / deactivate".
 */

import type { ScimUser, StoredUser, ScimEmail } from "../../skeleton/types.js";
import type { ScimPatchOperation } from "scim-patch";
import type {
  AcmeCorpQ3User,
  AcmeCorpQ3UserCreate,
  AcmeCorpQ3UserPatch,
} from "./types.js";

export const ENTERPRISE_SCHEMA =
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const USER_CORE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

// ---------------------------------------------------------------------------
// SCIM → native (create path)
// ---------------------------------------------------------------------------

/**
 * Translate a SCIM User create body into the HR system's create payload.
 * Throws on missing required fields so the SCIM route can surface a clean
 * 400 before ever hitting the target API.
 */
export function scimToAcmeCorpQ3Create(
  scim: Omit<ScimUser, "id" | "meta">,
): AcmeCorpQ3UserCreate {
  if (!scim.userName) {
    throw new Error(
      "SCIM userName is required — HR system uses it as uid (primary key)",
    );
  }

  const mail = pickPrimaryEmail(scim.emails);
  if (!mail) {
    throw new Error(
      "SCIM emails[primary=true].value is required — HR system requires a mail value",
    );
  }

  const givenName = scim.name?.givenName ?? "";
  // sn is nullable for single-token names per docs/patterns/ldap.md §4.
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
    // active defaults to true per RFC 7643 §4.1.1 (active is optional; absence = active).
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

function extractEnterprise(scim: Omit<ScimUser, "id" | "meta">): EnterpriseFields {
  const ext = scim.extensions?.[ENTERPRISE_SCHEMA];
  if (!ext || typeof ext !== "object") {
    return { employeeNumber: null, department: null, title: null };
  }
  const e = ext as Record<string, unknown>;
  return {
    employeeNumber: typeof e["employeeNumber"] === "string" ? e["employeeNumber"] : null,
    department: typeof e["department"] === "string" ? e["department"] : null,
    title: typeof e["title"] === "string" ? e["title"] : null,
  };
}

// ---------------------------------------------------------------------------
// Native → SCIM (read path)
// ---------------------------------------------------------------------------

/**
 * Translate an HR system user record into a fully-formed SCIM StoredUser.
 *
 * Enterprise extension schema URN is included in `schemas[]` ONLY when at
 * least one enterprise field is non-null (docs/patterns/ldap.md §2
 * "Enterprise extension, conditional"). Emitting an empty extension confuses
 * some Okta attribute-mapping rules.
 *
 * `meta.created` approximates to `lastModified` because the HR system does
 * not expose a separate creation timestamp (docs/patterns/ldap.md §2 note).
 * Timestamp format: YYYY-MM-DDTHH:mm:ssZ (no fractional seconds, UTC Z) per
 * okta-dialect.md §11.6 conservative default.
 */
export function acmeCorpQ3ToScim(native: AcmeCorpQ3User): StoredUser {
  const schemas: string[] = [USER_CORE_SCHEMA];

  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;
  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // name — omit familyName entirely when sn is null (Madonna case).
  // Per docs/patterns/ldap.md §4: do NOT emit `familyName: null`;
  // Okta consumers may reject null family names.
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
      // Drop milliseconds per okta-dialect.md §11.6 conservative timestamp default.
      lastModified: dropMillis(native.lastModified),
      created: dropMillis(native.lastModified),
      location: `/scim/v2/Users/${native.uid}`,
    },
  };

  if (hasEnterprise) {
    const ent: Record<string, unknown> = {};
    if (native.employeeNumber !== null) ent["employeeNumber"] = native.employeeNumber;
    if (native.department !== null) ent["department"] = native.department;
    if (native.title !== null) ent["title"] = native.title;
    stored.extensions = { [ENTERPRISE_SCHEMA]: ent };
  }

  return stored;
}

/**
 * Strip fractional seconds from an ISO-8601 string, normalising to
 * YYYY-MM-DDTHH:mm:ssZ. Safe to call on strings already in that format.
 * Per okta-dialect.md §11.6 [OPEN] conservative default for lastModified.
 */
function dropMillis(iso: string): string {
  return iso.replace(/\.\d+Z$/, "Z");
}

// ---------------------------------------------------------------------------
// SCIM PATCH → native PATCH (update path)
// ---------------------------------------------------------------------------

/**
 * Translate SCIM PATCH Operations (RFC 7644 §3.5.2) into the HR system's
 * PATCH payload.
 *
 * Handles all four Okta-observed PATCH shapes per okta-dialect.md §1 Table:
 *   A. replace, no path  — value is an object with multiple attrs
 *   B. replace, path="active"
 *   C. replace, path="name.givenName" / "name.familyName" / "name.formatted"
 *   D. replace, path="emails[type eq \"work\"].value"
 *
 * Per okta-dialect.md §1: ops are applied sequentially (RFC 7644 §3.5.2
 * requires sequential application, never parallel).
 *
 * Lifecycle policy "soft_delete" (OKT-60): PATCH active=false is the primary
 * deprovisioning signal per okta-dialect.md §3. Maps to enabled=false on the
 * HR system; the row is NEVER deleted from the source.
 *
 * Unknown paths → silent no-op (do NOT throw). A single unknown path in a
 * multi-op PATCH must not abort the whole operation per RFC 7644 §3.5.2
 * atomicity semantics — the op set is still atomic, but unrecognised paths
 * are treated as already-correct (idempotent no-op).
 */
export function scimPatchToAcmeCorpQ3Patch(
  ops: readonly ScimPatchOperation[],
): AcmeCorpQ3UserPatch {
  const patch: AcmeCorpQ3UserPatch = {};

  // Sequential application per RFC 7644 §3.5.2 and okta-dialect.md §1.
  for (const op of ops) {
    const opLower = op.op.toLowerCase();
    if (opLower !== "replace" && opLower !== "add") {
      // "remove" ops on scalar user fields are unusual; soft-delete is driven
      // by replace/active=false. Skip non-replace/add ops — they will be
      // handled if group support is added later.
      continue;
    }

    if (!op.path) {
      // Shape A: pathless replace — value is a multi-attr object.
      applyValueObject(op.value, patch);
    } else {
      // Shapes B/C/D: path-targeted replace.
      applyPathValue(op.path, op.value, patch);
    }
  }

  return patch;
}

function applyValueObject(value: unknown, patch: AcmeCorpQ3UserPatch): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  // active → enabled (soft_delete policy: okta-dialect.md §3 + OKT-60).
  if (typeof v["active"] === "boolean") patch.enabled = v["active"];

  // Nested name object in root-value form.
  if (typeof v["name"] === "object" && v["name"] !== null) {
    const n = v["name"] as Record<string, unknown>;
    if (typeof n["givenName"] === "string") patch.givenName = n["givenName"];
    if (typeof n["familyName"] === "string") patch.sn = n["familyName"];
    if (typeof n["formatted"] === "string") patch.cn = n["formatted"];
  }

  // Top-level scalar fields that Okta may include in a root-value replace.
  if (typeof v["displayName"] === "string") patch.cn = v["displayName"];
  if (typeof v["title"] === "string") patch.title = v["title"];
}

function applyPathValue(path: string, value: unknown, patch: AcmeCorpQ3UserPatch): void {
  // Normalise path for matching — Okta capitalisation is inconsistent in the
  // wild (okta-dialect.md §1 anti-patterns).
  const norm = path.toLowerCase();

  switch (norm) {
    // Lifecycle — the primary PATCH verb for soft-delete.
    // okta-dialect.md §3: "Okta's deprovisioning signal is PATCH active: false".
    case "active":
      if (typeof value === "boolean") patch.enabled = value;
      return;

    // Name fields.
    case "name.givenname":
      if (typeof value === "string") patch.givenName = value;
      return;
    case "name.familyname":
      if (typeof value === "string") patch.sn = value;
      return;
    case "name.formatted":
      if (typeof value === "string") patch.cn = value;
      return;

    // Enterprise extension fields — Okta emits these with the full
    // namespace prefix OR as bare paths depending on the attribute mapping
    // configured in the Okta app UI (okta-dialect.md §11.6 [OPEN]).
    case "title":
    case `${ENTERPRISE_SCHEMA.toLowerCase()}:title`:
      if (typeof value === "string") patch.title = value;
      return;
    case "department":
    case `${ENTERPRISE_SCHEMA.toLowerCase()}:department`:
      if (typeof value === "string") patch.department = value;
      return;
    case "employeenumber":
    case `${ENTERPRISE_SCHEMA.toLowerCase()}:employeenumber`:
      if (typeof value === "string") patch.employeeNumber = value;
      return;

    // Email — Okta may send `emails[type eq "work"].value` as a filter-path
    // per okta-dialect.md §1 Table row "replace with filter path". We parse
    // the simple work-email case here; a full filter-path parser is future
    // work (not required for OIN gating).
    case `emails[type eq "work"].value`:
    case "emails[type eq 'work'].value":
      if (typeof value === "string") patch.mail = value;
      return;

    default:
      // Unknown path — silent no-op per header comment.
      return;
  }
}