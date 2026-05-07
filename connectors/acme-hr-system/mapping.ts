/**
 * Attribute mapping between SCIM 2.0 (what Okta speaks) and Acme HR
 * System's native LDAP-shaped API (what the customer's app exposes).
 *
 * Pure functions — no I/O, no state, trivially testable.
 *
 * Pattern reference: docs/patterns/ldap.md §2 "SCIM target shape" and
 * §4 "Transformation notes".
 *
 * Lifecycle policy: soft_delete (OKT-10 ticket).
 * Deactivation (SCIM PATCH active:false OR HTTP DELETE) → {enabled: false}.
 * The PATCH path is the primary Okta signal per okta-dialect.md §3.
 *
 * Okta-dialect citations inline — required by Connector Law 3 DIALECT-CITED.
 *
 * Ticket: OKT-10
 */

import type { ScimUser, StoredUser, ScimEmail } from "../../skeleton/types.js";
import type { ScimPatchOperation } from "scim-patch";
import type {
  AcmeHrSystemUser,
  AcmeHrSystemUserCreate,
  AcmeHrSystemUserPatch,
} from "./types.js";

export const ENTERPRISE_SCHEMA =
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const USER_CORE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

// ---------------------------------------------------------------------------
// SCIM → Acme HR System (create)
// ---------------------------------------------------------------------------

/**
 * Translate a SCIM User POST body into the shape Acme HR System's
 * POST /users accepts.
 *
 * Throws on missing required fields (`userName`, primary email) so the
 * SCIM route can surface a clean 400 before hitting the target.
 */
export function scimToAcmeHrSystemCreate(
  scim: Omit<ScimUser, "id" | "meta">,
): AcmeHrSystemUserCreate {
  if (!scim.userName || scim.userName.trim() === "") {
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
  // sn: null for single-token names (Madonna case).
  // Omit familyName entirely in SCIM output; keep null in native payload.
  // See docs/patterns/ldap.md §4 "Single-token name handling".
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
    // active absent → true per RFC 7643 §4.1.1 (active is optional;
    // absence means active). okta-dialect.md §4.
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
  if (!sn) return given.trim();
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
    employeeNumber: typeof e["employeeNumber"] === "string" ? e["employeeNumber"] : null,
    department: typeof e["department"] === "string" ? e["department"] : null,
    title: typeof e["title"] === "string" ? e["title"] : null,
  };
}

// ---------------------------------------------------------------------------
// Acme HR System → SCIM (read)
// ---------------------------------------------------------------------------

/**
 * Translate a native Acme HR System user into a SCIM StoredUser.
 *
 * Enterprise extension is included only when at least one field is non-null.
 * Emitting an empty extension object is dishonest and some Okta attribute
 * mappings fail on it — per docs/patterns/ldap.md §4 "Enterprise extension,
 * conditional".
 *
 * meta.created is approximated as meta.lastModified because Acme HR System
 * does not expose a separate createdAt timestamp — documented in RUNBOOK.md
 * Known Limitations. See okta-dialect.md §11.6 (timestamp format).
 */
export function acmeHrSystemToScim(native: AcmeHrSystemUser): StoredUser {
  const schemas: string[] = [USER_CORE_SCHEMA];

  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;
  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // name: omit familyName when sn is null (single-token name).
  // Okta consumers are not required to handle null familyName and some
  // reject it — docs/patterns/ldap.md §4.
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
    // uid doubles as SCIM id AND userName — LDAP-backed SCIM convention.
    // Stable round-trip identity: okta-dialect.md §11.5 externalId semantics.
    userName: native.uid,
    name,
    emails: [{ value: native.mail, primary: true, type: "work" }],
    active: native.enabled,
    meta: {
      resourceType: "User",
      // ISO-8601 without fractional seconds per okta-dialect.md §11.6
      // conservative default.
      lastModified: stripMillis(native.lastModified),
      created: stripMillis(native.lastModified),
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
 * Strip fractional seconds from an ISO-8601 timestamp.
 * "2026-05-05T14:22:00.000Z" → "2026-05-05T14:22:00Z"
 * Conservative per okta-dialect.md §11.6 [OPEN] — Okta's expected format
 * for meta.lastModified is not fully specified; emit without fractions.
 */
function stripMillis(iso: string): string {
  return iso.replace(/\.\d+Z$/, "Z");
}

// ---------------------------------------------------------------------------
// SCIM PATCH → Acme HR System PATCH
// ---------------------------------------------------------------------------

/**
 * Translate SCIM PATCH operations into the Acme HR System native PATCH shape.
 *
 * Handles the four op shapes Okta emits in practice per okta-dialect.md §1:
 *   1. replace unscoped  — {op:"replace", value:{active:false, ...}}
 *   2. replace with path — {op:"replace", path:"active", value:false}
 *   3. add multi-valued  — {op:"add", path:"emails", value:[...]}
 *   4. remove with filter path — handled by acme-hr-system as a no-op at
 *      this layer (no first-class concept of removing a scalar attr)
 *
 * Ops are applied IN ORDER per RFC 7644 §3.5.2. This function iterates
 * sequentially, never in parallel — okta-dialect.md §1 "PATCH ordering bugs".
 *
 * Unknown paths are silently ignored (no-op) rather than thrown so that
 * multi-op PATCH atomicity works correctly: a single unknown path should not
 * abort an otherwise valid multi-op payload. Per okta-dialect.md §1.
 *
 * Lifecycle policy=soft_delete: active:false translates to {enabled:false}.
 * The DELETE path (which also soft-deletes) is handled in store.ts directly,
 * not via this function. okta-dialect.md §3.
 */
export function scimPatchToAcmeHrSystemPatch(
  ops: readonly ScimPatchOperation[],
): AcmeHrSystemUserPatch {
  const patch: AcmeHrSystemUserPatch = {};

  for (const op of ops) {
    const opLower = op.op.toLowerCase();

    if (opLower === "replace") {
      if (!op.path) {
        // Shape 1: unscoped replace — value is an object of attrs
        applyValueObject(op.value, patch);
      } else {
        // Shape 2: path-based replace
        applyPathValue(op.path, op.value, patch);
      }
    } else if (opLower === "add") {
      if (!op.path) {
        applyValueObject(op.value, patch);
      } else {
        // add with a path — relevant for emails, phones, etc.
        // For scalar fields this behaves identically to replace.
        applyPathValue(op.path, op.value, patch);
      }
    }
    // op: "remove" — no first-class scalar-remove in Acme HR System;
    // ignore rather than error (unknown-path no-op policy above).
  }

  return patch;
}

function applyValueObject(value: unknown, patch: AcmeHrSystemUserPatch): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  // active → enabled (lifecycle_policy=soft_delete: okta-dialect.md §3 + §4)
  if (typeof v["active"] === "boolean") patch.enabled = v["active"];

  // name fields via nested object
  if (typeof v["name"] === "object" && v["name"] !== null) {
    const n = v["name"] as Record<string, unknown>;
    if (typeof n["givenName"] === "string") patch.givenName = n["givenName"];
    if (typeof n["familyName"] === "string") patch.sn = n["familyName"];
    if (typeof n["formatted"] === "string") patch.cn = n["formatted"];
  }

  // flat scalar fields that might arrive in the value object
  if (typeof v["displayName"] === "string") patch.cn = v["displayName"];
  if (typeof v["title"] === "string") patch.title = v["title"];
}

function applyPathValue(
  path: string,
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  // Normalize to lowercase for case-insensitive path matching.
  // RFC 7644 §3.5.2 path attribute names are case-insensitive.
  const p = path.toLowerCase();

  switch (p) {
    case "active":
      // Primary Okta deactivation signal — okta-dialect.md §3 + §4.
      if (typeof value === "boolean") patch.enabled = value;
      break;

    case "name.givenname":
      if (typeof value === "string") patch.givenName = value;
      break;

    case "name.familyname":
      if (typeof value === "string") patch.sn = value;
      break;

    case "name.formatted":
      if (typeof value === "string") patch.cn = value;
      break;

    case "displayname":
      if (typeof value === "string") patch.cn = value;
      break;

    case "title":
      if (typeof value === "string") patch.title = value;
      break;

    case `${ENTERPRISE_SCHEMA.toLowerCase()}:employeenumber`:
    case "employeenumber":
      if (typeof value === "string" || value === null)
        patch.employeeNumber = value;
      break;

    case `${ENTERPRISE_SCHEMA.toLowerCase()}:department`:
    case "department":
      if (typeof value === "string" || value === null)
        patch.department = value;
      break;

    // emails[type eq "work"].value — Okta emits this shape per
    // okta-dialect.md §1 "replace with filter path". Acme HR System
    // has a single mail field; extract the scalar value from the SCIM
    // filter-path payload.
    case 'emails[type eq "work"].value':
    case "emails":
      if (typeof value === "string") {
        patch.mail = value;
      } else if (Array.isArray(value) && value.length > 0) {
        const first = value[0] as Record<string, unknown>;
        if (typeof first["value"] === "string") patch.mail = first["value"];
      }
      break;

    default:
      // Unknown path — silent no-op per header comment rationale.
      // Do NOT throw — would abort a multi-op PATCH. okta-dialect.md §1.
      break;
  }
}