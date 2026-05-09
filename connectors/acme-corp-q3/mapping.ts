/**
 * Attribute mapping between SCIM 2.0 (Okta-facing) and the AcmeCorpQ3
 * native LDAP-shaped API.
 *
 * Pure functions — no I/O, no side-effects, fully unit-testable.
 *
 * Pattern reference: docs/patterns/ldap.md
 *
 * Mapping decisions:
 *   - `uid` doubles as both SCIM `id` and `userName` (LDAP convention,
 *     docs/patterns/ldap.md §1).
 *   - Single-token name (sn=null) → omit name.familyName entirely rather
 *     than emitting null. Okta consumers may reject null familyName.
 *     See docs/patterns/ldap.md §4 (Madonna case).
 *   - Enterprise extension fields (employeeNumber, department, title) are
 *     conditionally included: omit the schema URN from schemas[] when all
 *     three are null (docs/patterns/ldap.md §3 — don't lie about what the
 *     resource has).
 *   - Primary email: scalar `mail` wrapped in multi-value SCIM array with
 *     primary:true, type:"work" (docs/patterns/ldap.md §2).
 *   - meta.created approximated as meta.lastModified — customer API
 *     exposes no separate creation timestamp (docs/patterns/ldap.md §1).
 *   - PATCH translation covers the OIN-gating subset per
 *     docs/okta-dialect.md §1:
 *       (A) op:replace, no path, value:{active:...}  — root-level unscoped
 *       (B) op:replace, path:"active"                — path-based scalar
 *       (C) op:replace, path:"name.givenName"        — name sub-attr
 *       (D) op:replace, path:"name.familyName"
 *       (E) op:replace, path:"name.formatted"
 *       (F) op:replace, path:"title"
 *       (G) op:replace, path:"emails[type eq "work"].value" — email update
 *     Unknown paths are silently skipped (RFC 7644 §3.5.2 atomicity — a
 *     single unknown path must not abort the whole multi-op PATCH).
 *   - Soft-delete lifecycle (lifecycle_policy=soft_delete, OKT-57):
 *     PATCH active=false → enabled=false. Row is NEVER deleted.
 *     See docs/okta-dialect.md §3.
 *
 * OIN citations:
 *   - docs/okta-dialect.md §1  (PATCH shapes)
 *   - docs/okta-dialect.md §3  (soft vs hard delete)
 *   - docs/okta-dialect.md §4  (active attribute semantics)
 *   - RFC 7643 §4.1.1          (User core schema, active attribute)
 *   - RFC 7644 §3.5.2          (PATCH atomicity)
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
// SCIM → AcmeCorpQ3 (write path: create)
// ---------------------------------------------------------------------------

/**
 * Convert a SCIM User creation body into the AcmeCorpQ3 native create shape.
 *
 * Throws on missing required fields (userName, mail) — the SCIM route layer
 * maps these exceptions to 400 + invalidValue per RFC 7644 §3.12.
 */
export function scimToAcmeCorpQ3Create(
  scim: Omit<ScimUser, "id" | "meta">,
): AcmeCorpQ3UserCreate {
  if (!scim.userName) {
    throw new Error(
      "SCIM userName is required — AcmeCorpQ3 uses it as uid (primary key)",
    );
  }

  const mail = pickPrimaryEmail(scim.emails);
  if (!mail) {
    throw new Error(
      "SCIM emails is required — AcmeCorpQ3 requires a mail value",
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
    // RFC 7643 §4.1.1: active absence means active; default true on create.
    // docs/okta-dialect.md §4.
    enabled: scim.active ?? true,
    memberOf: [],
  };
}

// ---------------------------------------------------------------------------
// AcmeCorpQ3 → SCIM (read path)
// ---------------------------------------------------------------------------

/**
 * Convert a native AcmeCorpQ3 user into a SCIM StoredUser.
 *
 * - Omits name.familyName when sn is null (Madonna case,
 *   docs/patterns/ldap.md §4).
 * - Omits enterprise schema URN + extension block when all enterprise
 *   fields are null (docs/patterns/ldap.md §3).
 * - meta.created approximated as lastModified (no createdAt in source,
 *   docs/patterns/ldap.md §1).
 * - Timestamp format: YYYY-MM-DDTHH:mm:ssZ (no fractional seconds,
 *   conservative default per docs/okta-dialect.md §11.6 [OPEN]).
 */
export function acmeCorpQ3ToScim(native: AcmeCorpQ3User): StoredUser {
  const schemas: string[] = [USER_CORE_SCHEMA];

  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;
  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // name sub-object — conditionally include sub-fields.
  // Omit familyName entirely when sn is null (not null — absent).
  const name: {
    givenName?: string;
    familyName?: string;
    formatted?: string;
  } = {};
  if (native.givenName) name.givenName = native.givenName;
  if (native.sn !== null) name.familyName = native.sn;
  if (native.cn) name.formatted = native.cn;

  // Normalise timestamp: strip fractional seconds for conservative
  // compatibility. docs/okta-dialect.md §11.6 [OPEN].
  const lastModified = stripMillis(native.lastModified);

  const stored: StoredUser = {
    schemas,
    id: native.uid,
    // uid doubles as userName per LDAP SCIM convention (docs/patterns/ldap.md §1).
    userName: native.uid,
    name,
    emails: [{ value: native.mail, primary: true, type: "work" }],
    // active maps directly to enabled (docs/okta-dialect.md §4).
    active: native.enabled,
    meta: {
      resourceType: "User",
      lastModified,
      // Approximate — no separate createdAt in AcmeCorpQ3 source.
      created: lastModified,
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

// ---------------------------------------------------------------------------
// SCIM PATCH → AcmeCorpQ3 PATCH (write path: update)
// ---------------------------------------------------------------------------

/**
 * Translate a sequence of SCIM PatchOperations into an AcmeCorpQ3 patch
 * object. Handles the four PATCH shapes Okta emits in practice:
 *
 *   (1) op:replace, no path, value:{active:false}   — deactivation
 *   (2) op:replace, path:"active", value:false       — path-based scalar
 *   (3) op:replace, path:"name.givenName"            — name sub-attrs
 *   (4) op:replace with filter path                  — email update
 *
 * Soft-delete: active=false → enabled=false. Row is never deleted.
 * docs/okta-dialect.md §3 (lifecycle_policy=soft_delete, OKT-57).
 *
 * Operations are applied sequentially in document order, never in
 * parallel, per RFC 7644 §3.5.2 (PATCH atomicity).
 * docs/okta-dialect.md §1.
 *
 * Unknown attribute paths → silent no-op (not a throw). A single unknown
 * path MUST NOT abort a multi-op PATCH.
 */
export function scimPatchToAcmeCorpQ3Patch(
  ops: readonly ScimPatchOperation[],
): AcmeCorpQ3UserPatch {
  const patch: AcmeCorpQ3UserPatch = {};

  // Sequential application per RFC 7644 §3.5.2 + docs/okta-dialect.md §1.
  for (const op of ops) {
    // Only "replace", "add", "remove" are legal (RFC 7644 §3.5.2).
    // We handle replace + add for scalar attrs; remove not needed for
    // the attribute types we support (lifecycle is via replace active=false).
    const opNorm = op.op?.toLowerCase();

    if (opNorm === "replace" || opNorm === "add") {
      if (!op.path) {
        // Shape A: unscoped replace — value is an object containing multiple
        // attrs. docs/okta-dialect.md §1 Table Row 1.
        applyUnscopedValue(op.value, patch);
      } else {
        // Shape B/C/D: path-based replace.
        // docs/okta-dialect.md §1 Table Rows 2/3.
        applyPathValue(String(op.path), op.value, patch);
      }
    }
    // op:remove — not needed for current required_ops; silently skip.
  }

  return patch;
}

// ---------------------------------------------------------------------------
// Helpers
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
      typeof e.employeeNumber === "string" ? e.employeeNumber : null,
    department: typeof e.department === "string" ? e.department : null,
    title: typeof e.title === "string" ? e.title : null,
  };
}

/**
 * Strip fractional seconds from an ISO-8601 string so we emit
 * YYYY-MM-DDTHH:mm:ssZ consistently.
 * docs/okta-dialect.md §11.6 [OPEN] — conservative timestamp format.
 */
function stripMillis(iso: string): string {
  return iso.replace(/\.\d+Z$/, "Z");
}

/**
 * Apply an unscoped PATCH replace value object (Shape A from §1).
 * Okta sends this shape for deactivation most commonly:
 *   {"op":"replace","value":{"active":false}}
 * docs/okta-dialect.md §1 Table Row 1.
 */
function applyUnscopedValue(
  value: unknown,
  patch: AcmeCorpQ3UserPatch,
): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  // active → enabled (soft-delete: false means deactivate, docs/okta-dialect.md §3).
  if (typeof v["active"] === "boolean") patch.enabled = v["active"];

  // displayName → cn
  if (typeof v["displayName"] === "string") patch.cn = v["displayName"];

  // name sub-object in root value form.
  if (typeof v["name"] === "object" && v["name"] !== null) {
    const n = v["name"] as Record<string, unknown>;
    if (typeof n["givenName"] === "string") patch.givenName = n["givenName"];
    if (typeof n["familyName"] === "string") patch.sn = n["familyName"];
    if (typeof n["formatted"] === "string") patch.cn = n["formatted"];
  }

  // emails array — pick the primary or first work email.
  if (Array.isArray(v["emails"])) {
    const mail = pickPrimaryEmail(v["emails"] as ScimEmail[]);
    if (mail) patch.mail = mail;
  }

  // Enterprise extension fields at root level (uncommon but possible).
  if (typeof v["title"] === "string") patch.title = v["title"];
  if (typeof v["department"] === "string") patch.department = v["department"];
}

/**
 * Apply a path-based PATCH operation (Shapes B/C/D from §1).
 *
 * Normalises path to lower-case for comparison. Filter-path expressions
 * like `emails[type eq "work"].value` are handled in the email case.
 *
 * Unknown paths are silently ignored — see header comment for rationale.
 * docs/okta-dialect.md §1 (unknown paths must not throw on multi-op PATCH).
 */
function applyPathValue(
  path: string,
  value: unknown,
  patch: AcmeCorpQ3UserPatch,
): void {
  // Normalise for case-insensitive path matching. RFC 7644 §3.5.2 path
  // grammar is case-insensitive for attribute names.
  const p = path.toLowerCase().trim();

  switch (true) {
    // Lifecycle — deactivation. docs/okta-dialect.md §3 + §4.
    // RFC 7643 §4.1.1 (active attribute).
    case p === "active":
      if (typeof value === "boolean") patch.enabled = value;
      return;

    // Name sub-attributes. docs/patterns/ldap.md §1.
    case p === "name.givenname":
      if (typeof value === "string") patch.givenName = value;
      return;

    case p === "name.familyname":
      if (typeof value === "string") patch.sn = value;
      return;

    case p === "name.formatted":
      if (typeof value === "string") patch.cn = value;
      return;

    // displayName → cn
    case p === "displayname":
      if (typeof value === "string") patch.cn = value;
      return;

    // Enterprise extension fields. docs/patterns/ldap.md §3.
    case p === "title":
    case p === `${ENTERPRISE_SCHEMA.toLowerCase()}:title`:
      if (typeof value === "string") patch.title = value;
      return;

    case p === "department":
    case p === `${ENTERPRISE_SCHEMA.toLowerCase()}:department`:
      if (typeof value === "string") patch.department = value;
      return;

    case p === "employeenumber":
    case p === `${ENTERPRISE_SCHEMA.toLowerCase()}:employeenumber`:
      if (typeof value === "string") patch.employeeNumber = value;
      return;

    // Email filter-path: emails[type eq "work"].value
    // docs/okta-dialect.md §1 Table Row 2.
    case p.startsWith("emails") && p.endsWith(".value"):
      if (typeof value === "string") patch.mail = value;
      return;

    // Scalar email path (some Okta versions).
    case p === "emails[primary eq true].value":
      if (typeof value === "string") patch.mail = value;
      return;

    default:
      // Unknown path — silent no-op per RFC 7644 §3.5.2 atomicity rationale.
      // docs/okta-dialect.md §1.
      return;
  }
}