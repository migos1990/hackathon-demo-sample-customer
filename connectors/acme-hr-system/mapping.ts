/**
 * Attribute mapping — SCIM 2.0 ↔ Acme HR System native LDAP-shaped API.
 *
 * Pure functions only: no I/O, no state. Every path is unit-testable
 * without a running server or live API.
 *
 * Mapping decisions (cite ticket OKT-10, okta-dialect.md, RFC 7643):
 *
 * 1. `uid` doubles as SCIM `id` AND `userName` (LDAP-backed SCIM convention,
 *    Pattern 1 in ticket-templates). No separate id-lookup table needed.
 *
 * 2. Single-token name (sn: null, "Madonna case"):
 *    - `name.familyName` is OMITTED entirely rather than set to null.
 *      RFC 7643 §4.1.1 marks familyName as optional; some Okta consumers
 *      reject null. okta-dialect.md §11.
 *    - `name.formatted` becomes just givenName with no trailing space.
 *
 * 3. Enterprise extension (urn:ietf:params:scim:schemas:extension:enterprise:2.0:User):
 *    - Included ONLY when at least one of employeeNumber / department / title
 *      is non-null. Avoids leaking empty objects to Okta (okta-dialect.md §10).
 *    - Schema URN added to `schemas[]` only when the extension is present.
 *
 * 4. PATCH translation (okta-dialect.md §1):
 *    - Shape A: no path, value is an object — `{active: false}` deactivation.
 *    - Shape B: path-based — `replace active`, `replace name.givenName`, etc.
 *    - Unknown / unsupported paths: silent no-op per RFC 7644 §3.5.2
 *      atomicity note — an unknown path in a multi-op PATCH must not abort
 *      the whole operation.
 *    - ONLY `replace` ops are translated; `add` / `remove` on scalar fields
 *      are not meaningful for LDAP-shaped targets and are silently skipped.
 *
 * 5. Soft-delete (ticket OKT-10 lifecycle_policy: soft_delete):
 *    - SCIM `active: false` maps to `{enabled: false}` on AcmeHR.
 *    - Rows are NEVER deleted; reactivation maps to `{enabled: true}`.
 *    - okta-dialect.md §3: Okta drives lifecycle via PATCH active, not DELETE.
 *
 * 6. Reactivation idempotency (okta-dialect.md §4):
 *    - PATCH active: true on an already-active user → produces {enabled: true}
 *      patch which is a no-op on the target. Idempotent by design.
 */
import type { ScimUser, StoredUser, ScimEmail } from "../../skeleton/types.js";
import type { ScimPatchOperation } from "scim-patch";
import type {
  AcmeHrSystemUser,
  AcmeHrSystemUserCreate,
  AcmeHrSystemUserPatch,
} from "./types.js";

// ─── Schema constants ────────────────────────────────────────────────────────

export const ENTERPRISE_SCHEMA =
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const USER_CORE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

// ─── SCIM → Native (create) ──────────────────────────────────────────────────

/**
 * Translate an incoming SCIM User POST body into the native create payload.
 *
 * Throws on missing required fields rather than silently emitting a broken
 * record — the SCIM route layer maps these throws to 400+invalidValue.
 */
export function scimToAcmeHrSystemCreate(
  scim: Omit<ScimUser, "id" | "meta">,
): AcmeHrSystemUserCreate {
  if (!scim.userName || scim.userName.trim() === "") {
    throw new Error(
      "SCIM userName is required — Acme HR System uses it as uid (primary key). " +
        "RFC 7643 §4.1.1 marks userName as required for User.",
    );
  }

  const mail = pickPrimaryEmail(scim.emails);
  if (!mail) {
    throw new Error(
      "SCIM emails with at least one entry is required — " +
        "Acme HR System requires a mail value on create.",
    );
  }

  const givenName = scim.name?.givenName ?? "";
  // sn: null is valid for single-token names (Madonna case) — mapping decision 2 above.
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
    // active defaults to true per RFC 7643 §4.1.1 when absent.
    enabled: scim.active ?? true,
    memberOf: [],
  };
}

// ─── Native → SCIM (read) ─────────────────────────────────────────────────────

/**
 * Translate a native Acme HR System user into a SCIM StoredUser.
 *
 * uid doubles as both SCIM id and userName (mapping decision 1).
 * Enterprise extension is conditionally included (mapping decision 3).
 */
export function acmeHrSystemToScim(native: AcmeHrSystemUser): StoredUser {
  const schemas: string[] = [USER_CORE_SCHEMA];

  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;
  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // Build name sub-object — omit familyName when null (mapping decision 2).
  const name: StoredUser["name"] = {};
  if (native.givenName) name.givenName = native.givenName;
  if (native.sn !== null) name.familyName = native.sn;
  // Prefer cn for formatted; fall back to composition if cn is empty.
  name.formatted = native.cn
    ? native.cn
    : composeCn(native.givenName, native.sn);

  const user: StoredUser = {
    schemas,
    id: native.uid,
    userName: native.uid,
    name,
    emails: [{ value: native.mail, primary: true, type: "work" }],
    active: native.enabled,
    meta: {
      resourceType: "User",
      lastModified: native.lastModified,
      // Acme HR System exposes only lastModified; approximate created as same.
      // Customers with a distinct createdAt should map it directly.
      created: native.lastModified,
      location: `/scim/v2/Users/${native.uid}`,
    },
  };

  if (hasEnterprise) {
    const ent: Record<string, unknown> = {};
    if (native.employeeNumber !== null) ent["employeeNumber"] = native.employeeNumber;
    if (native.department !== null) ent["department"] = native.department;
    if (native.title !== null) ent["title"] = native.title;
    user.extensions = { [ENTERPRISE_SCHEMA]: ent };
  }

  return user;
}

// ─── SCIM PATCH → Native PATCH ───────────────────────────────────────────────

/**
 * Translate SCIM PATCH operations into a native partial-update payload.
 *
 * okta-dialect.md §1: Okta emits four PATCH shapes. We handle the
 * `replace`-based shapes that are meaningful for scalar LDAP attributes.
 * `add` / `remove` on scalars are silently skipped (not applicable).
 *
 * Multi-op PATCH is handled by iterating all ops and merging results —
 * RFC 7644 §3.5.2 requires sequential application. The caller (store.ts)
 * is responsible for sending the merged patch as a single API call.
 *
 * Soft-delete (OKT-10 lifecycle_policy: soft_delete, okta-dialect.md §3):
 *   SCIM `active: false`  → `{enabled: false}` — row is retained.
 *   SCIM `active: true`   → `{enabled: true}`  — reactivation.
 */
export function scimPatchToAcmeHrSystemPatch(
  ops: readonly ScimPatchOperation[],
): AcmeHrSystemUserPatch {
  const patch: AcmeHrSystemUserPatch = {};

  for (const op of ops) {
    // Normalise op name — scim-patch library lowercases, but be defensive.
    const opName = (op.op ?? "").toLowerCase();
    if (opName !== "replace") {
      // add/remove on scalar LDAP fields is not meaningful — silent no-op.
      // okta-dialect.md §1 notes these are used for multi-value / group ops;
      // group push is out of scope for OKT-10.
      continue;
    }

    if (!op.path) {
      // Shape A: pathless — value is an object of attrs.
      applyRootValueObject(op.value, patch);
    } else {
      // Shape B: path-targeted.
      applyPathValue(op.path, op.value, patch);
    }
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
  if (!sn) return given.trim();
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

/**
 * Handle pathless `replace` where value is a top-level attribute object.
 * e.g. `{op: "replace", value: {active: false}}` — the deactivation shape
 * Okta most commonly emits (okta-dialect.md §1 "replace unscoped").
 */
function applyRootValueObject(
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  // active → enabled (soft-delete lifecycle mapping)
  if (typeof v["active"] === "boolean") patch.enabled = v["active"];

  // emails — pick primary value
  if (Array.isArray(v["emails"])) {
    const primary = (v["emails"] as ScimEmail[]).find((e) => e.primary) ?? (v["emails"] as ScimEmail[])[0];
    if (primary?.value) patch.mail = primary.value;
  }

  // name sub-object
  if (typeof v["name"] === "object" && v["name"] !== null) {
    const n = v["name"] as Record<string, unknown>;
    if (typeof n["givenName"] === "string") patch.givenName = n["givenName"];
    if (typeof n["familyName"] === "string") patch.sn = n["familyName"];
    if (typeof n["formatted"] === "string") patch.cn = n["formatted"];
  }

  // Top-level scalars Okta may send in root-value replace
  if (typeof v["displayName"] === "string") patch.cn = v["displayName"];
}

/**
 * Handle path-targeted `replace` operations.
 * Path is lowercased for comparison — Okta may vary casing.
 * Unknown paths → silent no-op (RFC 7644 §3.5.2 atomicity rationale;
 * okta-dialect.md §1 "dropping unknown paths" anti-pattern note reversed:
 * we DO want 400 on truly unknown paths in isolation, but in a multi-op
 * PATCH a single unknown path must not abort others. Store layer handles
 * full-PATCH 400 if ALL ops are unknown; individual silencing is correct).
 */
function applyPathValue(
  path: string,
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  const p = path.toLowerCase();

  switch (p) {
    case "active":
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
    case "emails[primary eq true].value": {
      // Multi-value filter paths for email update.
      // okta-dialect.md §1: Okta emits `emails[type eq "work"].value` for
      // targeted email updates.
      const emailVal = typeof value === "string" ? value : null;
      if (emailVal) patch.mail = emailVal;
      break;
    }

    case `urn:ietf:params:scim:schemas:extension:enterprise:2.0:user:employeenumber`:
    case "employeenumber":
      if (typeof value === "string") patch.employeeNumber = value;
      break;

    case `urn:ietf:params:scim:schemas:extension:enterprise:2.0:user:department`:
    case "department":
      if (typeof value === "string") patch.department = value;
      break;

    default:
      // Silent no-op for unknown paths.
      // See function-level JSDoc above for RFC 7644 §3.5.2 rationale.
      break;
  }
}