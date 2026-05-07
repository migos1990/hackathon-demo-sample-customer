/**
 * Attribute mapping between SCIM 2.0 (Okta) and Acme HR System's
 * LDAP-shaped native API.
 *
 * Pure functions — no I/O, no state. Every transform is independently
 * testable. Pattern follows connectors/acme-hr/mapping.ts (Pattern 1,
 * LDAP-shaped source — docs/patterns/ldap.md).
 *
 * Mapping decisions:
 *
 *   uid ↔ SCIM id + userName (LDAP-backed SCIM convention — both fields
 *     carry the same opaque string, keeping filter-by-userName and
 *     get-by-id lookups consistent without a separate ID table).
 *
 *   cn → name.formatted (direct pass-through; composed from givenName +
 *     familyName as fallback when cn is absent).
 *
 *   sn: null → omit name.familyName entirely (Madonna case per
 *     docs/patterns/ldap.md §4; never emit null on a SCIM field Okta
 *     may reject).
 *
 *   mail → emails[{value, primary:true, type:"work"}] (single scalar
 *     wrapped per RFC 7643 §4.1.2 multi-value contract).
 *
 *   Enterprise extension only when at least one of employeeNumber /
 *     department / title is non-null (docs/patterns/ldap.md §3 —
 *     "conditional enterprise extension").
 *
 *   lifecycle_policy = "soft_delete": PATCH active:false → enabled:false.
 *     Row is NEVER deleted. okta-dialect.md §3.
 *
 *   PATCH: supports the four Okta-emitted shapes per okta-dialect.md §1:
 *     - replace unscoped (value object)
 *     - replace with simple path (active, name.givenName, etc.)
 *     - add multi-value (emails) — translated to mail update
 *     - remove with filter path — not applicable to scalar fields; silently
 *       ignored rather than thrown to preserve PATCH atomicity per
 *       RFC 7644 §3.5.2.
 *
 * Citations:
 *   - okta-dialect.md §1 (PATCH shapes)
 *   - okta-dialect.md §3 (soft delete)
 *   - okta-dialect.md §4 (active attribute)
 *   - okta-dialect.md §6 (attribute deprovisioning — not configured for
 *     OKT-10; deactivation clears only `enabled`, no PII zeroing)
 *   - RFC 7643 §4.1 (User schema)
 *   - RFC 7644 §3.5.2 (PATCH atomicity)
 */
import type { ScimUser, StoredUser, ScimEmail } from "../../skeleton/types.js";
import type { ScimPatchOperation } from "scim-patch";
import type {
  AcmeHrSystemUser,
  AcmeHrSystemUserCreate,
  AcmeHrSystemUserPatch,
} from "./types.js";

// ─── Schema URNs ────────────────────────────────────────────────────────────

export const CORE_USER_SCHEMA =
  "urn:ietf:params:scim:schemas:core:2.0:User";
export const ENTERPRISE_SCHEMA =
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

// ─── SCIM → AcmeHrSystem (create) ───────────────────────────────────────────

/**
 * Translate an incoming SCIM POST /Users body into AcmeHrSystem's create
 * shape. Throws on missing required fields so the SCIM route can surface
 * a 400 before the network round-trip.
 */
export function scimToAcmeHrSystemCreate(
  scim: Omit<ScimUser, "id" | "meta">,
): AcmeHrSystemUserCreate {
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
    // RFC 7643 §4.1.1: absence of active means active per Okta convention;
    // default true. okta-dialect.md §4.
    enabled: scim.active ?? true,
    memberOf: [],
  };
}

// ─── AcmeHrSystem → SCIM (read) ─────────────────────────────────────────────

/**
 * Translate a native AcmeHrSystem user into a StoredUser (SCIM shape with
 * guaranteed `id` + `meta` fields). Called on every read path (GET by id,
 * list, post-patch response).
 *
 * Enterprise extension: omitted entirely when all three fields are null
 * (docs/patterns/ldap.md §3). An empty extension object is a lie about
 * the resource and causes attribute mapping failures in some Okta configs.
 *
 * meta.created approximated from lastModified — Acme HR System does not
 * expose a separate creation timestamp. See docs/patterns/ldap.md §2.
 *
 * Timestamp format: YYYY-MM-DDTHH:mm:ssZ (no fractional seconds) per
 * okta-dialect.md §11.6 conservative default.
 */
export function acmeHrSystemToScim(native: AcmeHrSystemUser): StoredUser {
  const schemas = [CORE_USER_SCHEMA];
  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;
  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // name object — omit familyName entirely rather than null for sn:null
  // (Madonna case, docs/patterns/ldap.md §4).
  const name: NonNullable<ScimUser["name"]> = {};
  if (native.givenName) name.givenName = native.givenName;
  if (native.sn !== null) name.familyName = native.sn;
  if (native.cn) name.formatted = native.cn;

  const stored: StoredUser = {
    schemas,
    id: native.uid,
    userName: native.uid,
    name,
    emails: [
      { value: native.mail, primary: true, type: "work" },
    ],
    active: native.enabled,
    meta: {
      resourceType: "User",
      // okta-dialect.md §11.6: strip fractional seconds, emit Z suffix.
      lastModified: stripMillis(native.lastModified),
      created: stripMillis(native.lastModified),
      location: `/scim/v2/Users/${native.uid}`,
    },
  };

  if (hasEnterprise) {
    const ent: Record<string, unknown> = {};
    if (native.employeeNumber !== null)
      ent.employeeNumber = native.employeeNumber;
    if (native.department !== null) ent.department = native.department;
    if (native.title !== null) ent.title = native.title;
    stored.extensions = { [ENTERPRISE_SCHEMA]: ent };
  }

  return stored;
}

// ─── SCIM PATCH → AcmeHrSystem PATCH ────────────────────────────────────────

/**
 * Translate SCIM PatchOp operations into an AcmeHrSystem PATCH object.
 *
 * Handles the four Okta-emitted PATCH shapes per okta-dialect.md §1:
 *
 *   Shape 1 — replace unscoped, value is object:
 *     {"op":"replace","value":{"active":false}}
 *     → {enabled: false}
 *
 *   Shape 2 — replace with simple dotted path:
 *     {"op":"replace","path":"active","value":false}
 *     → {enabled: false}
 *
 *   Shape 3 — add multi-value (emails):
 *     {"op":"add","path":"emails","value":[{"value":"new@...","primary":true}]}
 *     → picks the primary email and sets mail.
 *
 *   Shape 4 — remove with filter path:
 *     {"op":"remove","path":"members[value eq \"...\"]"}
 *     → groups not in scope for OKT-10; silently ignored to preserve
 *       PATCH atomicity (RFC 7644 §3.5.2).
 *
 * ops are applied sequentially per RFC 7644 §3.5.2. Unknown paths are
 * silently no-op'd (not thrown) so that a multi-op PATCH containing one
 * unknown path doesn't abort all the valid ops.
 *
 * Soft-delete semantics (lifecycle_policy = "soft_delete" — OKT-10):
 *   active:false → enabled:false (row retained). okta-dialect.md §3.
 */
export function scimPatchToAcmeHrSystemPatch(
  ops: readonly ScimPatchOperation[],
): AcmeHrSystemUserPatch {
  const patch: AcmeHrSystemUserPatch = {};

  for (const op of ops) {
    const opLower = (op.op as string).toLowerCase();

    if (opLower === "replace") {
      if (!op.path) {
        // Shape 1: unscoped replace — value is a partial user object.
        applyUnscopedReplace(op.value, patch);
      } else {
        // Shape 2: path-based replace.
        applyPathReplace(op.path as string, op.value, patch);
      }
    } else if (opLower === "add") {
      // Shape 3: add to multi-value attribute (emails most common).
      applyAdd(op.path as string | undefined, op.value, patch);
    }
    // Shape 4 (remove) — groups not in scope for OKT-10; silently no-op.
    // If group support is added later, wire remove ops here.
  }

  return patch;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

/**
 * Strip fractional seconds from an ISO-8601 timestamp and normalise to Z
 * suffix. okta-dialect.md §11.6 conservative default: emit
 * YYYY-MM-DDTHH:mm:ssZ.
 */
function stripMillis(iso: string): string {
  return iso.replace(/\.\d+Z$/, "Z").replace(/\+00:00$/, "Z");
}

function applyUnscopedReplace(
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  // active → enabled (soft_delete: never DELETE, only flip flag)
  // okta-dialect.md §3 + §4.
  if (typeof v["active"] === "boolean") patch.enabled = v["active"];

  // name sub-object may appear inline in the value object.
  if (typeof v["name"] === "object" && v["name"] !== null) {
    const n = v["name"] as Record<string, unknown>;
    if (typeof n["givenName"] === "string") patch.givenName = n["givenName"];
    if (typeof n["familyName"] === "string") patch.sn = n["familyName"];
    if (typeof n["formatted"] === "string") patch.cn = n["formatted"];
  }

  if (typeof v["displayName"] === "string") patch.cn = v["displayName"];
  if (typeof v["title"] === "string") patch.title = v["title"];

  // emails: if the value carries an emails array, pick primary mail.
  if (Array.isArray(v["emails"])) {
    const mail = pickPrimaryEmail(v["emails"] as ScimEmail[]);
    if (mail) patch.mail = mail;
  }
}

function applyPathReplace(
  path: string,
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  // Normalise path to lowercase for case-insensitive matching per common
  // Okta behaviour (okta-dialect.md §1 — path-based replace examples).
  const p = path.toLowerCase();

  switch (p) {
    case "active":
      // okta-dialect.md §3: deactivation via PATCH active:false
      // → enabled:false (soft_delete policy — row retained).
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

    case "emails":
    case `emails[type eq "work"].value`:
      // Single-value path targeting the work email.
      if (typeof value === "string") patch.mail = value;
      break;

    // Enterprise extension paths — strip the URN prefix Okta may include.
    case `${ENTERPRISE_SCHEMA.toLowerCase()}:employeenumber`:
    case "employeenumber":
      if (typeof value === "string") patch.employeeNumber = value;
      break;

    case `${ENTERPRISE_SCHEMA.toLowerCase()}:department`:
    case "department":
      if (typeof value === "string") patch.department = value;
      break;

    default:
      // Unknown path — silent no-op preserves PATCH atomicity across a
      // multi-op body. RFC 7644 §3.5.2. okta-dialect.md §1.
      break;
  }
}

function applyAdd(
  path: string | undefined,
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  // Shape 3: Okta sends add+path="emails" with an array value containing
  // the new primary email. okta-dialect.md §1 multi-value add.
  if (!path) return;
  const p = path.toLowerCase();
  if (p === "emails" && Array.isArray(value)) {
    const mail = pickPrimaryEmail(value as ScimEmail[]);
    if (mail) patch.mail = mail;
  }
  // Other multi-value adds (photos, phoneNumbers) are not mapped in
  // OKT-10 scope; silently ignored.
}