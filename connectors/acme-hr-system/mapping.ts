/**
 * Attribute mapping between SCIM 2.0 (Okta-facing) and the Acme HR System
 * native LDAP-shaped API. Pure functions — no I/O, no state.
 *
 * ticket: OKT-10
 * customer: Acme HR System
 * slug: acme-hr-system
 *
 * Mapping decisions:
 *   - `uid` doubles as SCIM `id` AND `userName` (LDAP-backed SCIM convention;
 *     docs/patterns/ldap.md §2).
 *   - Primary email is required on create; mapping throws if absent.
 *   - Single-token names (sn: null) round-trip cleanly:
 *     `name.familyName` is OMITTED (not nulled) per okta-dialect.md §11.1
 *     and docs/patterns/ldap.md §4 (the "Madonna case").
 *   - Enterprise extension emitted only when at least one field is non-null;
 *     omitting the URN from schemas[] entirely when extension would be empty
 *     prevents Okta attribute-mapping failures on empty extension objects
 *     per docs/patterns/ldap.md §3 "Enterprise extension, conditional".
 *   - PATCH ops: four Okta-emitted shapes handled per okta-dialect.md §1:
 *       1. replace unscoped  : {op:"replace", value:{active:false}}
 *       2. replace with path : {op:"replace", path:"active", value:false}
 *       3. replace name.*    : {op:"replace", path:"name.givenName", value:"..."}
 *       4. add/remove skipped for non-group paths (no group ops in OKT-10)
 *     Unknown paths → silent no-op (RFC 7644 §3.5.2 atomicity: a single
 *     unknown path must NOT abort the whole multi-op PATCH).
 *   - lifecycle_policy: soft_delete (OKT-10) — no hard delete in any path.
 *     Deactivation always maps to {enabled: false}, never removes the row.
 *     Per okta-dialect.md §3 and §4.
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
// SCIM → AcmeHrSystem  (used on POST /Users)
// ---------------------------------------------------------------------------

/**
 * Translate a SCIM user create body into an AcmeHrSystem create payload.
 *
 * Throws if required fields are absent (userName, primary email).
 * The SCIM route layer catches these and maps to 400 + invalidValue.
 */
export function scimToAcmeHrSystemCreate(
  scim: Omit<ScimUser, "id" | "meta">,
): AcmeHrSystemUserCreate {
  if (!scim.userName) {
    throw new Error(
      "SCIM userName is required — AcmeHrSystem uses it as uid (primary key)",
    );
  }

  const mail = pickPrimaryEmail(scim.emails);
  if (!mail) {
    throw new Error(
      "SCIM emails is required — AcmeHrSystem requires a mail value",
    );
  }

  const givenName = scim.name?.givenName ?? "";
  const sn = scim.name?.familyName ?? null;
  const cn =
    scim.name?.formatted !== undefined
      ? scim.name.formatted
      : composeCn(givenName, sn);

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
    // Per RFC 7643 §4.1.1: absence of active means active (default true).
    enabled: scim.active ?? true,
    memberOf: [],
  };
}

// ---------------------------------------------------------------------------
// AcmeHrSystem → SCIM  (used on all reads)
// ---------------------------------------------------------------------------

/**
 * Translate an AcmeHrSystem native user into a SCIM StoredUser.
 *
 * The enterprise extension URN is included in schemas[] only when at least
 * one enterprise field is non-null — per docs/patterns/ldap.md §3
 * "Enterprise extension, conditional" and okta-dialect.md §10.
 */
export function acmeHrSystemToScim(native: AcmeHrSystemUser): StoredUser {
  const schemas: string[] = [USER_CORE_SCHEMA];

  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;
  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // Single-token name: omit familyName entirely rather than emit null.
  // Per docs/patterns/ldap.md §4 and okta-dialect.md §11.1.
  const name: NonNullable<StoredUser["name"]> = {};
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
      // AcmeHrSystem exposes only lastModified, not a separate createdAt.
      // Approximate created as lastModified (same strategy as acme-hr reference
      // connector per docs/patterns/ldap.md §2 "Mapping decisions").
      // Per okta-dialect.md §11.6 open item: emit YYYY-MM-DDTHH:mm:ssZ (no
      // fractional seconds, UTC Z) as the conservative default.
      lastModified: stripMillis(native.lastModified),
      created: stripMillis(native.lastModified),
      location: `/scim/v2/Users/${native.uid}`,
    },
  };

  if (hasEnterprise) {
    const ext: Record<string, unknown> = {};
    if (native.employeeNumber !== null) ext.employeeNumber = native.employeeNumber;
    if (native.department !== null) ext.department = native.department;
    if (native.title !== null) ext.title = native.title;
    stored.extensions = { [ENTERPRISE_SCHEMA]: ext };
  }

  return stored;
}

// ---------------------------------------------------------------------------
// SCIM PATCH → AcmeHrSystem PATCH
// ---------------------------------------------------------------------------

/**
 * Translate a sequence of SCIM PATCH operations into an AcmeHrSystem patch
 * payload. Handles the four Okta-emitted shapes per okta-dialect.md §1.
 *
 * Operations are applied sequentially (left-to-right) per RFC 7644 §3.5.2
 * ("The server MUST apply all Operations atomically"). Here "sequential"
 * means we accumulate the merged patch object; the final object is what
 * gets sent to the target API.
 *
 * lifecycle_policy: soft_delete — setting enabled:false is the only
 * deactivation action; no row deletion ever occurs via this path.
 */
export function scimPatchToAcmeHrSystemPatch(
  ops: readonly ScimPatchOperation[],
): AcmeHrSystemUserPatch {
  const patch: AcmeHrSystemUserPatch = {};

  for (const op of ops) {
    // We handle replace ops. Add/remove on non-members paths are no-ops for
    // this connector (no group ops in OKT-10 scope).
    const opLower = (op.op as string).toLowerCase();
    if (opLower !== "replace") continue;

    if (!op.path) {
      // Shape 1: unscoped replace — value is a multi-attr object.
      // e.g. {op:"replace", value:{active:false}}
      // Per okta-dialect.md §1 "replace unscoped" shape.
      applyValueObject(op.value, patch);
    } else {
      // Shape 2/3: path-based replace.
      // e.g. {op:"replace", path:"active", value:false}
      applyPathValue(op.path as string, op.value, patch);
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

function extractEnterprise(scim: Omit<ScimUser, "id" | "meta">): EnterpriseFields {
  const ext = scim.extensions?.[ENTERPRISE_SCHEMA];
  if (!ext || typeof ext !== "object") {
    return { employeeNumber: null, department: null, title: null };
  }
  const e = ext as Record<string, unknown>;
  return {
    employeeNumber: typeof e.employeeNumber === "string" ? e.employeeNumber : null,
    department: typeof e.department === "string" ? e.department : null,
    title: typeof e.title === "string" ? e.title : null,
  };
}

/**
 * Apply an unscoped replace-value object (Shape 1).
 * Per okta-dialect.md §1 table row "replace unscoped".
 */
function applyValueObject(
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  if (typeof v.active === "boolean") {
    // lifecycle_policy: soft_delete — active:false → enabled:false (never delete).
    // Per okta-dialect.md §3 and §4.
    patch.enabled = v.active;
  }

  if (typeof v.mail === "string") patch.mail = v.mail;
  if (typeof v.title === "string") patch.title = v.title;

  if (typeof v.name === "object" && v.name !== null) {
    const n = v.name as Record<string, unknown>;
    if (typeof n.givenName === "string") patch.givenName = n.givenName;
    if (typeof n.familyName === "string") patch.sn = n.familyName;
    if (typeof n.formatted === "string") patch.cn = n.formatted;
  }

  // Enterprise extension fields embedded in the value object.
  const ent = v[ENTERPRISE_SCHEMA];
  if (typeof ent === "object" && ent !== null) {
    const e = ent as Record<string, unknown>;
    if (typeof e.employeeNumber === "string") patch.employeeNumber = e.employeeNumber;
    if (typeof e.department === "string") patch.department = e.department;
    if (typeof e.title === "string") patch.title = e.title;
  }
}

/**
 * Apply a path-targeted replace value (Shapes 2 & 3).
 * Per okta-dialect.md §1 table rows "replace with filter path" and
 * "replace unscoped" (path variant).
 *
 * Unknown paths → silent no-op per RFC 7644 §3.5.2 atomicity rationale
 * in the module header.
 */
function applyPathValue(
  path: string,
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  // Normalise path for case-insensitive matching; the attribute names in
  // SCIM are case-insensitive per RFC 7643 §2.1.
  const p = path.toLowerCase();

  switch (p) {
    case "active":
      // lifecycle_policy: soft_delete — active:false → enabled:false.
      // Per okta-dialect.md §3 and §4.
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

    case "emails[type eq \"work\"].value":
    case "emails":
      // Per okta-dialect.md §1 "replace with filter path" shape.
      if (typeof value === "string") patch.mail = value;
      // Array form: pick first element's value.
      if (Array.isArray(value) && value.length > 0) {
        const first = value[0] as Record<string, unknown>;
        if (typeof first.value === "string") patch.mail = first.value;
      }
      return;

    case `${ENTERPRISE_SCHEMA.toLowerCase()}:employeenumber`:
    case "employeenumber":
      if (typeof value === "string") patch.employeeNumber = value;
      return;

    case `${ENTERPRISE_SCHEMA.toLowerCase()}:department`:
    case "department":
      if (typeof value === "string") patch.department = value;
      return;

    default:
      // Unknown or unsupported path — silent no-op.
      // RFC 7644 §3.5.2: unknown path should yield 400+invalidPath, BUT in
      // multi-op PATCH flows Okta may include paths the connector doesn't
      // support alongside paths it does. Silent no-op is the pragmatic choice
      // for this connector scope; see module header and okta-dialect.md §1
      // "Anti-patterns" for the trade-off discussion.
      return;
  }
}

/**
 * Drop fractional seconds from an ISO-8601 timestamp and ensure UTC Z suffix.
 * Conservative default per okta-dialect.md §11.6 open item on
 * `meta.lastModified` timestamp format.
 * e.g. "2026-05-05T14:22:00.000Z" → "2026-05-05T14:22:00Z"
 */
function stripMillis(iso: string): string {
  return iso.replace(/\.\d+Z$/, "Z");
}