/**
 * Attribute mapping — SCIM 2.0 ↔ Acme Corp Q3 HR API (LDAP-shaped).
 *
 * Pure functions. No I/O, no state. Every decision is tested in
 * connectors/acme-corp-q3/mapping.test.ts.
 *
 * Pattern: docs/patterns/ldap.md (LDAP-shaped source, Pattern 1).
 *
 * Key mapping decisions:
 *   - `uid` doubles as SCIM `id` AND `userName` (LDAP-backed SCIM convention
 *     per docs/patterns/ldap.md §2).
 *   - Single-token names: `sn: null` → omit `name.familyName` entirely.
 *     See docs/patterns/ldap.md §4 (Single-token name handling).
 *   - Enterprise extension (employeeNumber, department, title) is only
 *     included in `schemas[]` and response body when at least one field is
 *     non-null, per docs/patterns/ldap.md §3 (Enterprise extension,
 *     conditional).
 *   - Lifecycle policy is soft_delete (ticket OKT-54): PATCH active:false →
 *     {enabled: false}. Rows are never hard-deleted. See okta-dialect.md §3.
 *   - PATCH translation handles both root-value form and path-based form per
 *     okta-dialect.md §1 (all four PATCH shapes Okta emits).
 *   - Unknown PATCH paths are a silent no-op, NOT a throw. RFC 7644 §3.5.2
 *     atomicity: a single unrecognised path must not abort the whole
 *     multi-op PATCH. See okta-dialect.md §1 (Anti-patterns).
 */
import type { ScimUser, StoredUser, ScimEmail } from "../../skeleton/types.js";
import type { ScimPatchOperation } from "scim-patch";
import type {
  AcmeCorpQ3User,
  AcmeCorpQ3UserCreate,
  AcmeCorpQ3UserPatch,
} from "./types.js";

// ─── Schema URNs ────────────────────────────────────────────────────────────

export const ENTERPRISE_SCHEMA =
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

const USER_CORE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

// ─── SCIM → AcmeCorpQ3 (create) ─────────────────────────────────────────────

/**
 * Translate an incoming SCIM User POST body into the shape expected by
 * the Acme Corp Q3 HR API's POST /users endpoint.
 *
 * Throws (not returns an error) on missing required fields so the calling
 * store can let the error propagate to the SCIM route layer, which maps it
 * to 400 + scimType:invalidValue per RFC 7644 §3.12.
 */
export function scimToAcmeCorpQ3Create(
  scim: Omit<ScimUser, "id" | "meta">,
): AcmeCorpQ3UserCreate {
  if (!scim.userName) {
    throw new Error(
      "SCIM userName is required — Acme Corp Q3 HR API uses it as uid (primary key)",
    );
  }

  const mail = pickPrimaryEmail(scim.emails);
  if (!mail) {
    throw new Error(
      "SCIM emails is required — Acme Corp Q3 HR API requires a mail value",
    );
  }

  const givenName = scim.name?.givenName ?? "";
  // sn null = single-token name (Madonna case). See docs/patterns/ldap.md §4.
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
    // RFC 7643 §4.1.1: active is optional; absent means active. Default true.
    enabled: scim.active ?? true,
    memberOf: [],
  };
}

// ─── AcmeCorpQ3 → SCIM (read) ───────────────────────────────────────────────

/**
 * Translate a native HR API user record into a SCIM StoredUser suitable
 * for returning to Okta.
 *
 * Follows docs/patterns/ldap.md §2 (SCIM target shape) and §3 (Mapping
 * decisions).
 */
export function acmeCorpQ3ToScim(native: AcmeCorpQ3User): StoredUser {
  const schemas: string[] = [USER_CORE_SCHEMA];

  // Enterprise extension: only include when at least one field is non-null.
  // Docs: docs/patterns/ldap.md §3 (Enterprise extension, conditional).
  // Rationale: emitting an empty extension object is a lie about the resource
  // shape and can confuse Okta attribute mappings.
  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;
  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // name — omit familyName entirely when sn is null (single-token name).
  // See docs/patterns/ldap.md §4 and okta-dialect.md §11 (edge cases).
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
      // HR system only exposes lastModified; approximate created as same.
      // Real customers with a separate createdAt column map it directly.
      // See docs/patterns/ldap.md §2 (Mapping decisions locked in).
      lastModified: native.lastModified,
      created: native.lastModified,
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

// ─── SCIM PATCH → AcmeCorpQ3 PATCH ──────────────────────────────────────────

/**
 * Translate an array of SCIM PatchOp operations into the partial update
 * shape the Acme Corp Q3 HR API expects on PATCH /users/:uid.
 *
 * Handles the four PATCH shapes Okta emits in practice
 * (okta-dialect.md §1, Table "What Okta sends in practice"):
 *   1. replace, no path — value is an object with multiple attrs
 *   2. replace, path-based — e.g. path:"active", value:false
 *   3. add, multi-valued — handled defensively (same as replace for scalar fields)
 *   4. remove, filter-path — not applicable to Users in this connector
 *      (no multi-value fields the customer needs to strip), silently ignored.
 *
 * Lifecycle policy (soft_delete, ticket OKT-54):
 *   - active:false → {enabled: false}
 *   - active:true  → {enabled: true}  (reactivation)
 *   Rows are NEVER deleted via this path. See okta-dialect.md §3.
 *
 * RFC 7644 §3.5.2: ops are applied sequentially; unknown paths are a no-op,
 * not an error. The route layer wraps this in a try/catch so an upstream
 * throw from the client still surfaces correctly.
 */
export function scimPatchToAcmeCorpQ3Patch(
  ops: readonly ScimPatchOperation[],
): AcmeCorpQ3UserPatch {
  const patch: AcmeCorpQ3UserPatch = {};

  for (const op of ops) {
    const opLower = op.op.toLowerCase();

    // remove ops on Users in this connector are no-ops (no multi-value
    // targets configured in OKT-54). Do not throw — see header comment.
    if (opLower === "remove") continue;

    // Handle replace and add uniformly for scalar fields.
    if (opLower === "replace" || opLower === "add") {
      if (!op.path) {
        // Shape 1: no path → value is an object map of attrs.
        applyValueObject(op.value, patch);
      } else {
        // Shape 2/3: path-based update.
        applyPathValue(String(op.path), op.value, patch);
      }
    }
    // Any other op string is silently skipped — RFC 7644 §3.5.2 atomicity.
  }

  return patch;
}

// ─── Private helpers ─────────────────────────────────────────────────────────

function pickPrimaryEmail(emails: ScimEmail[] | undefined): string | null {
  if (!emails || emails.length === 0) return null;
  const primary = emails.find((e) => e.primary === true);
  return (primary ?? emails[0])!.value;
}

function composeCn(givenName: string, sn: string | null): string {
  if (!sn) return givenName;
  return `${givenName} ${sn}`.trim();
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

/**
 * Apply a root-level value object (PATCH shape 1 — no path).
 * Only maps attrs this connector explicitly owns; all others are silently
 * skipped per RFC 7644 §3.5.2.
 */
function applyValueObject(value: unknown, patch: AcmeCorpQ3UserPatch): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  // active → enabled (soft_delete lifecycle, ticket OKT-54, okta-dialect.md §3)
  if (typeof v["active"] === "boolean") patch.enabled = v["active"];

  // name.* nested within root value object
  if (typeof v["name"] === "object" && v["name"] !== null) {
    const n = v["name"] as Record<string, unknown>;
    if (typeof n["givenName"] === "string") patch.givenName = n["givenName"];
    if (typeof n["familyName"] === "string") patch.sn = n["familyName"];
    if (typeof n["formatted"] === "string") patch.cn = n["formatted"];
  }

  // emails — update mail if a primary email is present in the value
  if (Array.isArray(v["emails"])) {
    const mail = pickPrimaryEmail(v["emails"] as ScimEmail[]);
    if (mail) patch.mail = mail;
  }

  // Enterprise extension fields (may arrive inline on root replace)
  if (typeof v["employeeNumber"] === "string") patch.employeeNumber = v["employeeNumber"];
  if (typeof v["department"] === "string") patch.department = v["department"];
  if (typeof v["title"] === "string") patch.title = v["title"];
}

/**
 * Apply a path-based PATCH value (PATCH shapes 2 & 3).
 *
 * Path matching is case-insensitive on the attribute name per RFC 7643
 * §2.1 ("Attribute names are case insensitive"). Multi-value filter paths
 * (e.g. `emails[type eq "work"].value`) are handled for the email case;
 * all others that aren't explicitly mapped are silent no-ops.
 *
 * okta-dialect.md §1: Okta emits filter-path shapes for multi-valued attrs.
 * This connector handles the work-email case which is the most common.
 */
function applyPathValue(
  path: string,
  value: unknown,
  patch: AcmeCorpQ3UserPatch,
): void {
  const normalized = path.toLowerCase().trim();

  switch (normalized) {
    // ── Lifecycle (okta-dialect.md §3 + §4) ───────────────────────────────
    case "active":
      if (typeof value === "boolean") patch.enabled = value;
      return;

    // ── Name fields ────────────────────────────────────────────────────────
    case "name.givenname":
      if (typeof value === "string") patch.givenName = value;
      return;
    case "name.familyname":
      if (typeof value === "string") patch.sn = value;
      return;
    case "name.formatted":
      if (typeof value === "string") patch.cn = value;
      return;

    // ── Email (filter-path form: emails[type eq "work"].value) ─────────────
    // okta-dialect.md §1: Okta uses filter-path for multi-valued element updates.
    case 'emails[type eq "work"].value':
    case "emails[primary eq true].value":
      if (typeof value === "string") patch.mail = value;
      return;

    // ── Enterprise extension (path-based form) ─────────────────────────────
    case `${ENTERPRISE_SCHEMA.toLowerCase()}:employeenumber`:
    case "employeenumber":
      if (typeof value === "string") patch.employeeNumber = value;
      return;
    case `${ENTERPRISE_SCHEMA.toLowerCase()}:department`:
    case "department":
      if (typeof value === "string") patch.department = value;
      return;
    case `${ENTERPRISE_SCHEMA.toLowerCase()}:title`:
    case "title":
      if (typeof value === "string") patch.title = value;
      return;

    default:
      // Unknown or unimplemented path — silent no-op per RFC 7644 §3.5.2.
      // Do NOT throw here; that would abort the entire multi-op PATCH.
      return;
  }
}