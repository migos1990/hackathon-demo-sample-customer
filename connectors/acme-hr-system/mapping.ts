/**
 * Attribute mapping between SCIM 2.0 (Okta-facing) and Acme HR System's
 * native LDAP-shaped API. Pure functions — no I/O, no state.
 *
 * Pattern: docs/patterns/ldap.md (LDAP-shaped source).
 * Okta dialect citations inline per Connector Law 3 (DIALECT-CITED).
 *
 * Key mapping decisions (see docs/patterns/ldap.md §2 for rationale):
 *   - `uid` doubles as SCIM `id` AND `userName`.
 *   - `sn: null` ↔ `name.familyName` omitted (Madonna case).
 *   - Enterprise extension included only when ≥1 field is non-null.
 *   - Primary email wrapping: `mail` (scalar) → `emails[{primary:true,type:"work"}]`.
 *   - PATCH: handles both root-value-object form and path-based form per
 *     docs/okta-dialect.md §1 "Four shapes Okta sends".
 *   - Lifecycle (soft_delete per OKT-10): `active: false` → `enabled: false`;
 *     rows are NEVER physically removed per docs/okta-dialect.md §3.
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
const CORE_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

// ---------------------------------------------------------------------------
// SCIM → Acme HR System (create path)
// ---------------------------------------------------------------------------

/**
 * Translate an incoming SCIM POST /Users body into the native create shape.
 *
 * Throws a descriptive Error (not a SCIM error — the store layer converts)
 * when required fields are absent.
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
      "SCIM emails[primary].value is required — Acme HR System requires a mail value",
    );
  }

  const givenName = scim.name?.givenName ?? "";
  // sn is null when familyName is absent (single-token name / Madonna case)
  // per docs/patterns/ldap.md §4.
  const sn = scim.name?.familyName ?? null;
  const cn =
    scim.name?.formatted ?? composeCn(givenName, sn);

  const enterprise = extractEnterpriseFields(scim);

  return {
    uid: scim.userName,
    cn,
    givenName,
    sn,
    mail,
    employeeNumber: enterprise.employeeNumber,
    title: enterprise.title,
    department: enterprise.department,
    // active defaults to true when absent — RFC 7643 §4.1.1: absence of
    // `active` means active.
    enabled: scim.active ?? true,
    memberOf: [],
  };
}

// ---------------------------------------------------------------------------
// Acme HR System → SCIM (read path)
// ---------------------------------------------------------------------------

/**
 * Translate a native Acme HR System user into a SCIM StoredUser.
 *
 * Enterprise extension URN is included in `schemas[]` only when at least
 * one enterprise field is non-null per docs/patterns/ldap.md §4
 * "Enterprise extension, conditional" — avoids leaking empty objects to Okta.
 */
export function acmeHrSystemToScim(native: AcmeHrSystemUser): StoredUser {
  const schemas = [CORE_USER_SCHEMA];

  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;
  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // name object — omit familyName entirely when sn is null (Madonna case).
  // Emitting `familyName: null` causes some Okta attribute-mapping failures;
  // omit the key instead per docs/patterns/ldap.md §4.
  const name: NonNullable<StoredUser["name"]> = {};
  if (native.givenName) name.givenName = native.givenName;
  if (native.sn !== null) name.familyName = native.sn;
  if (native.cn) name.formatted = native.cn;

  const stored: StoredUser = {
    schemas,
    id: native.uid, // uid → SCIM id (LDAP convention, docs/patterns/ldap.md §2)
    userName: native.uid,
    name,
    // Wrap scalar mail into multi-value SCIM emails array.
    // docs/patterns/ldap.md §4 "Primary-email selection".
    emails: [{ value: native.mail, primary: true, type: "work" }],
    active: native.enabled,
    meta: {
      resourceType: "User",
      lastModified: native.lastModified,
      // Acme HR System exposes only lastModified; approximate created as same.
      // Customers with a separate createdAt should map it directly per
      // docs/patterns/ldap.md §2 "Mapping decisions locked in".
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
// SCIM PATCH operations → native patch (update + deactivation path)
// ---------------------------------------------------------------------------

/**
 * Translate SCIM PATCH operations into the native partial-update shape.
 *
 * Handles the four PATCH shapes Okta emits per docs/okta-dialect.md §1:
 *   1. replace unscoped:  `{op:"replace", value:{active:false}}`
 *   2. replace with path: `{op:"replace", path:"active", value:false}`
 *   3. add multi-valued:  `{op:"add", path:"emails", value:[...]}` (email updates)
 *   4. remove with filter path: handled at group level; for users, silently ignored
 *
 * Soft-delete policy (OKT-10 lifecycle_policy: soft_delete): both
 * `active: false` on PATCH and the DELETE route translate to `enabled: false`.
 * Rows are never physically removed from Acme HR System. See
 * docs/okta-dialect.md §3 "Three customer policies" table, soft_delete row.
 *
 * Unknown paths are silently ignored (no-op). RFC 7644 §3.5.2 atomicity
 * means an unknown path in a multi-op PATCH must NOT abort the whole
 * operation — the whole PatchOp applies or reverts, but an unknown-path
 * no-op is different from a failure. Documented as a known limitation in
 * RUNBOOK.md §6.
 */
export function scimPatchToAcmeHrSystemPatch(
  ops: readonly ScimPatchOperation[],
): AcmeHrSystemUserPatch {
  const patch: AcmeHrSystemUserPatch = {};

  for (const op of ops) {
    const opLower = (op.op ?? "").toLowerCase();

    if (opLower === "replace") {
      if (!op.path) {
        // Shape 1: root-value-object form — `{op:"replace", value:{active:false,...}}`
        applyRootValueObject(op.value, patch);
      } else {
        // Shape 2: path-based form — `{op:"replace", path:"active", value:false}`
        applyPathValue(op.path, op.value, patch);
      }
    } else if (opLower === "add") {
      if (op.path) {
        // Shape 3: add with path (multi-value append)
        applyAddWithPath(op.path, op.value, patch);
      } else {
        // add without path is structurally the same as replace root-value-object
        applyRootValueObject(op.value, patch);
      }
    }
    // op: remove at user level is silently ignored; group membership remove
    // is handled at the Groups router (future work per RUNBOOK.md §6).
  }

  return patch;
}

/**
 * Deactivation shortcut — returns the minimal native patch to soft-delete
 * a user. Called by both the PATCH-active-false flow and the DELETE handler.
 *
 * docs/okta-dialect.md §3: "DELETE handler and PATCH-active-false handler
 * MUST be policy-consistent."
 * docs/okta-dialect.md §4: "active: false MUST hide the user from unfiltered
 * GET /Users."
 */
export function buildDeactivatePatch(): AcmeHrSystemUserPatch {
  return { enabled: false };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

function extractEnterpriseFields(
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

/**
 * Apply a root-level value object (no-path replace/add) to the patch
 * accumulator. Handles the most common Okta PATCH shape for deactivation:
 * `{op:"replace", value:{active:false}}` per docs/okta-dialect.md §1.
 */
function applyRootValueObject(
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  // active → enabled (docs/okta-dialect.md §4)
  if (typeof v["active"] === "boolean") {
    patch.enabled = v["active"];
  }

  // name sub-object
  if (typeof v["name"] === "object" && v["name"] !== null) {
    const n = v["name"] as Record<string, unknown>;
    if (typeof n["givenName"] === "string") patch.givenName = n["givenName"];
    if (typeof n["familyName"] === "string") patch.sn = n["familyName"];
    if (typeof n["formatted"] === "string") patch.cn = n["formatted"];
  }

  // flat-key name variants (Okta sometimes hoists these)
  if (typeof v["givenName"] === "string") patch.givenName = v["givenName"];
  if (typeof v["familyName"] === "string") patch.sn = v["familyName"];
  if (typeof v["displayName"] === "string") patch.cn = v["displayName"];

  // emails[0].value → mail
  if (Array.isArray(v["emails"]) && v["emails"].length > 0) {
    const first = v["emails"][0] as Record<string, unknown>;
    if (typeof first["value"] === "string") patch.mail = first["value"];
  }

  // enterprise extension fields passed inline (non-standard but observed)
  if (typeof v["title"] === "string") patch.title = v["title"];
  if (typeof v["department"] === "string") patch.department = v["department"];
  if (typeof v["employeeNumber"] === "string")
    patch.employeeNumber = v["employeeNumber"];
}

/**
 * Apply a path-based PATCH value to the accumulator.
 *
 * Path grammar per RFC 7644 §3.4.2.2; the subset Okta actually emits for
 * User resources per docs/okta-dialect.md §1 "Four shapes Okta sends":
 *   active, name.givenName, name.familyName, name.formatted,
 *   emails[type eq "work"].value, title, department, employeeNumber
 */
function applyPathValue(
  path: string,
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  // Normalise to lower-case for matching; actual values are used as-is.
  const p = path.toLowerCase().trim();

  switch (p) {
    case "active":
      // docs/okta-dialect.md §4 — deactivation via path-based PATCH.
      // docs/okta-dialect.md §3 — soft_delete policy maps active:false to enabled:false.
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

    // Complex filter path for work email:
    // `emails[type eq "work"].value` per docs/okta-dialect.md §1
    case 'emails[type eq "work"].value':
    case "emails[type eq 'work'].value":
    case "emails.value": // simplified variant
      if (typeof value === "string") patch.mail = value;
      return;

    case "title":
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

    default:
      // Unknown path — silent no-op per RFC 7644 §3.5.2 atomicity reasoning.
      // See RUNBOOK.md §6 "Known limitations — unknown PATCH paths".
      return;
  }
}

/**
 * Apply an `add` operation that carries a path (typically multi-value append).
 * For User resources the only add-with-path Okta sends in practice is
 * `emails` append per docs/okta-dialect.md §1 "add multi-valued".
 */
function applyAddWithPath(
  path: string,
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  const p = path.toLowerCase().trim();

  if (p === "emails") {
    // Append semantics — treat the first new entry as the primary email if
    // none of the existing entries are primary. For Acme HR System (scalar
    // mail field) we simply overwrite with the new primary value.
    if (Array.isArray(value) && value.length > 0) {
      const emails = value as Array<Record<string, unknown>>;
      const primary = emails.find((e) => e["primary"] === true) ?? emails[0];
      if (primary && typeof primary["value"] === "string") {
        patch.mail = primary["value"];
      }
    }
    return;
  }

  // Delegate to path-based replace for all other add-with-path cases.
  applyPathValue(path, value, patch);
}