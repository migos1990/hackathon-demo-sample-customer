/**
 * Attribute mapping: SCIM 2.0 ↔ Acme HR System native API (OKT-10).
 *
 * Pure functions — no I/O, no state. All mapping decisions are tested in
 * connectors/acme-hr-system/mapping.test.ts.
 *
 * Mapping decisions:
 *   - `uid` is both SCIM `id` and `userName` (LDAP convention, see
 *     docs/patterns/ldap.md §2).
 *   - `sn: null` → SCIM `name.familyName` omitted entirely (not null) to
 *     avoid Okta rejecting null familyName; documented as the "Madonna case"
 *     in docs/patterns/ldap.md §4 and §5.
 *   - Enterprise extension (employeeNumber, department, title) is emitted
 *     ONLY when at least one field is non-null. When all null, the URN is
 *     omitted from `schemas[]` too — per docs/patterns/ldap.md §2 rationale:
 *     "omit vs empty" distinction matters to Okta attribute mappers.
 *   - `lastModified` doubles as `meta.created` (customer has no separate
 *     createdAt column — same approximation as the AcmeHR reference connector).
 *   - PATCH translation supports the four Okta-emitted shapes documented in
 *     okta-dialect.md §1: replace-unscoped, replace-with-path, add
 *     multi-valued, remove-with-filter. Only replace is semantically
 *     meaningful for scalar user attributes; add/remove on multi-valued
 *     paths (emails, phoneNumbers) are no-ops here because AcmeHR-System
 *     uses a single `mail` scalar (no multi-value email array on the target).
 *     Unknown paths are silently skipped — NOT thrown — so a multi-op PATCH
 *     containing one unknown path does not abort the whole atomic operation
 *     per RFC 7644 §3.5.2.
 *
 * Citations:
 *   - okta-dialect.md §1 (PATCH shapes Okta emits)
 *   - okta-dialect.md §3 (soft-delete — active:false never deletes)
 *   - okta-dialect.md §4 (active attribute behavior)
 *   - okta-dialect.md §6 (attribute deprovisioning — OKT-10 does NOT zero
 *     attributes on deactivation; lifecycle_policy=soft_delete only)
 *   - RFC 7643 §4.1.1 (User core schema)
 *   - RFC 7644 §3.5.2 (PATCH atomicity)
 */
import type { ScimPatchOperation } from "scim-patch";
import type { ScimUser, StoredUser, ScimEmail } from "../../skeleton/types.js";
import type {
  AcmeHrSystemUser,
  AcmeHrSystemUserCreate,
  AcmeHrSystemUserPatch,
} from "./types.js";

export const ENTERPRISE_SCHEMA =
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const USER_CORE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

// ---------------------------------------------------------------------------
// SCIM → AcmeHrSystem (create path)
// ---------------------------------------------------------------------------

/**
 * Translate a SCIM User CREATE body into AcmeHR System's native create shape.
 *
 * Throws on missing required fields (userName, primary email) so the SCIM
 * route can return 400 + scimType:invalidValue before hitting the network.
 */
export function scimToAcmeHrSystemCreate(
  scim: Omit<ScimUser, "id" | "meta">,
): AcmeHrSystemUserCreate {
  if (!scim.userName || scim.userName.trim() === "") {
    throw new Error(
      "SCIM userName is required — AcmeHR System uses it as uid (primary key)",
    );
  }

  const mail = pickPrimaryEmail(scim.emails);
  if (!mail) {
    throw new Error(
      "SCIM emails with at least one entry is required — AcmeHR System requires mail",
    );
  }

  const givenName = scim.name?.givenName ?? "";
  // sn null = single-token name (Madonna case). Preserve null.
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
    // okta-dialect.md §4: active absent → treat as true (RFC 7643 §4.1.1).
    enabled: scim.active ?? true,
    memberOf: [],
  };
}

/** Pick the primary email from the SCIM emails array, falling back to first. */
function pickPrimaryEmail(emails: ScimEmail[] | undefined): string | null {
  if (!emails || emails.length === 0) return null;
  const primary = emails.find((e) => e.primary === true);
  return (primary ?? emails[0])!.value;
}

/** Compose a CN from given + sn. Handles sn=null (single-token). */
function composeCn(given: string, sn: string | null): string {
  if (!sn) return given.trim();
  return `${given} ${sn}`.trim();
}

interface EnterpriseFields {
  employeeNumber: string | null;
  department: string | null;
  title: string | null;
}

/** Extract enterprise extension fields from a SCIM user body. */
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
// AcmeHrSystem → SCIM (read path)
// ---------------------------------------------------------------------------

/**
 * Translate an AcmeHR System native user into a SCIM StoredUser.
 *
 * Enterprise extension URN is added to `schemas[]` ONLY when at least one
 * enterprise field is non-null — per docs/patterns/ldap.md §2 "enterprise
 * extension, conditional".
 */
export function acmeHrSystemToScim(native: AcmeHrSystemUser): StoredUser {
  const schemas: string[] = [USER_CORE_SCHEMA];

  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;

  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // name object — omit familyName entirely when sn is null (Madonna case).
  // okta-dialect.md §11.1 / docs/patterns/ldap.md §4.
  const name: NonNullable<ScimUser["name"]> = {};
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
      // AcmeHR System stamps lastModified on every write. No separate
      // createdAt column — approximate created as lastModified.
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

// ---------------------------------------------------------------------------
// SCIM PATCH → AcmeHrSystem PATCH (update path)
// ---------------------------------------------------------------------------

/**
 * Translate an array of SCIM PatchOperations into AcmeHR System's native
 * patch shape.
 *
 * Handles all four shapes Okta emits (okta-dialect.md §1):
 *
 *   Shape A — replace, no path:
 *     {"op":"replace","value":{"active":false}}
 *     → sets enabled:false (the primary deactivation flow, OIN SPEC step 7)
 *
 *   Shape B — replace, path-based:
 *     {"op":"replace","path":"active","value":false}
 *     → same as shape A
 *
 *   Shape C — add, multi-valued (e.g. emails):
 *     {"op":"add","path":"emails","value":[{...}]}
 *     → The customer's API uses a scalar `mail` field, not a multi-value
 *        array. We extract the primary value if present; otherwise no-op.
 *
 *   Shape D — remove with filter path:
 *     {"op":"remove","path":"members[value eq \"...\"]"}
 *     → Not applicable for User attributes on AcmeHR System (groups are
 *        read-only on this connector). Silently ignored.
 *
 * RFC 7644 §3.5.2: unknown paths are silently skipped so a multi-op PATCH
 * with one unknown path does not abort the full atomic operation.
 *
 * Lifecycle policy (OKT-10): soft_delete.
 *   - active:false  → enabled:false (retain row)
 *   - active:true   → enabled:true  (reactivation)
 * The row is NEVER deleted. See okta-dialect.md §3.
 */
export function scimPatchToAcmeHrSystemPatch(
  ops: readonly ScimPatchOperation[],
): AcmeHrSystemUserPatch {
  const patch: AcmeHrSystemUserPatch = {};

  for (const op of ops) {
    const opLower = op.op.toLowerCase();

    if (opLower === "replace") {
      if (!op.path) {
        // Shape A: value is an object of attribute → value pairs.
        applyReplaceValueObject(op.value, patch);
      } else {
        // Shape B: path-targeted replace.
        applyReplaceByPath(op.path as string, op.value, patch);
      }
    } else if (opLower === "add") {
      // Shape C: add to multi-valued. Only email is meaningful here.
      if (typeof op.path === "string" && op.path.toLowerCase() === "emails") {
        applyEmailAdd(op.value, patch);
      }
      // All other add targets are no-ops for this connector.
    }
    // opLower === "remove": Shape D — no-op for AcmeHR System user attributes.
  }

  return patch;
}

/**
 * Apply a path-less replace — `value` is a flat or nested object of attrs.
 *
 * Common Okta payload: `{"op":"replace","value":{"active":false}}`
 * (deactivation — okta-dialect.md §1, okta-dialect.md §3).
 */
function applyReplaceValueObject(
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  // active → enabled (okta-dialect.md §4)
  if (typeof v["active"] === "boolean") patch.enabled = v["active"];

  // name.* nested object form
  if (typeof v["name"] === "object" && v["name"] !== null) {
    const n = v["name"] as Record<string, unknown>;
    if (typeof n["givenName"] === "string") patch.givenName = n["givenName"];
    if (typeof n["familyName"] === "string") patch.sn = n["familyName"];
    if (typeof n["formatted"] === "string") patch.cn = n["formatted"];
  }

  // Flat alternatives Okta sometimes sends in value-object form.
  if (typeof v["displayName"] === "string") patch.cn = v["displayName"];
  if (typeof v["title"] === "string") patch.title = v["title"];

  // emails in value-object form — pick primary
  if (Array.isArray(v["emails"])) {
    const mail = pickPrimaryEmail(v["emails"] as ScimEmail[]);
    if (mail) patch.mail = mail;
  }
}

/**
 * Apply a path-targeted replace.
 *
 * Path strings are lower-cased for matching to tolerate Okta casing
 * variations. Complex filter paths (e.g. `emails[type eq "work"].value`)
 * are handled by the emails case below; all others that aren't in the
 * known set are silently skipped.
 */
function applyReplaceByPath(
  path: string,
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  const p = path.toLowerCase();

  switch (p) {
    // Lifecycle — okta-dialect.md §3 + §4
    case "active":
      if (typeof value === "boolean") patch.enabled = value;
      break;

    // Name fields
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

    // Enterprise fields
    case "title":
      if (typeof value === "string") patch.title = value;
      break;
    case "urn:ietf:params:scim:schemas:extension:enterprise:2.0:user:department":
    case "department":
      if (typeof value === "string") patch.department = value;
      break;
    case "urn:ietf:params:scim:schemas:extension:enterprise:2.0:user:employeenumber":
    case "employeenumber":
      if (typeof value === "string") patch.employeeNumber = value;
      break;

    // Email — both simple path and complex filter path variants
    // okta-dialect.md §1: `emails[type eq "work"].value`
    case "emails":
    case 'emails[type eq "work"].value':
    case "emails[primary eq true].value":
      if (typeof value === "string") patch.mail = value;
      else if (Array.isArray(value)) {
        const mail = pickPrimaryEmail(value as ScimEmail[]);
        if (mail) patch.mail = mail;
      }
      break;

    default:
      // Unknown path — silent no-op. RFC 7644 §3.5.2: atomicity means one
      // unknown path must not abort the entire multi-op PATCH.
      break;
  }
}

/**
 * Handle `op:add, path:emails, value:[{...}]` (Shape C).
 * AcmeHR System uses a scalar mail field; pick the primary from the array.
 */
function applyEmailAdd(value: unknown, patch: AcmeHrSystemUserPatch): void {
  if (!Array.isArray(value)) return;
  const mail = pickPrimaryEmail(value as ScimEmail[]);
  if (mail) patch.mail = mail;
}