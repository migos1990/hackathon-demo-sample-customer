/**
 * Attribute mapping between SCIM 2.0 (Okta-facing) and Acme HR System's
 * native LDAP-shaped REST API (OKT-10).
 *
 * Pure functions — no I/O, no state. Fully unit-testable.
 *
 * Source pattern: Pattern 1 (LDAP-shaped source) per
 *   docs/attribute-mapping-patterns.md#pattern-1-ldap-shaped-source
 *   Reference implementation: connectors/acme-hr/mapping.ts
 *
 * Mapping decisions:
 *   - `uid` doubles as SCIM `id` AND `userName` (LDAP-backed SCIM convention).
 *   - Single-token names: `sn: null` → `familyName` omitted entirely (not null)
 *     per Pattern 1 §4 "Madonna case" + okta-dialect.md §2 case/normalization.
 *   - Primary email wrapping: scalar `mail` → [{value, primary:true, type:"work"}].
 *   - Enterprise extension emitted only when ≥1 field is non-null
 *     (Pattern 1 §3 "Enterprise extension, conditional").
 *   - `meta.created` approximated from `lastModified` — Acme HR System has no
 *     separate creation timestamp.
 *   - Lifecycle: PATCH ops that set `active` translate to `{enabled: <bool>}`.
 *     Both root-value `{value:{active:false}}` and path-based `{path:"active"}`
 *     forms are supported per okta-dialect.md §1 (four PATCH shapes).
 *   - Unknown PATCH paths are silently no-op'd per RFC 7644 §3.5.2 atomicity
 *     rationale (a single unknown path must not abort the whole operation).
 *
 * OIN-gating note: the PATCH translation here covers the OIN-required
 * deactivation flow (SPEC Test step 7) — `active: false` must reach the
 * target app as `enabled: false`.
 */

import type { ScimUser, StoredUser, ScimEmail } from "../../skeleton/types.js";
import type { ScimPatchOperation } from "scim-patch";
import type {
  AcmeHrSystemUser,
  AcmeHrSystemUserCreate,
  AcmeHrSystemUserPatch,
} from "./types.js";

// ── Schema URNs ────────────────────────────────────────────────────────────────

export const ENTERPRISE_SCHEMA =
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const USER_CORE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

// ── SCIM → Acme HR System (create) ────────────────────────────────────────────

/**
 * Translate a validated SCIM User POST body into an AcmeHrSystemUserCreate.
 *
 * Throws on missing required fields — the caller (store.create) catches
 * these and re-throws as 400-class SCIM errors where appropriate.
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
  // sn: null is the Madonna case — single-token name, no surname.
  const sn = scim.name?.familyName ?? null;
  // cn: prefer formatted; fall back to composed "Given Family" (trimmed).
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
    // SCIM active defaults to true when absent per RFC 7643 §4.1.1.
    enabled: scim.active ?? true,
    memberOf: [],
  };
}

// ── Acme HR System → SCIM (read) ──────────────────────────────────────────────

/**
 * Translate a persisted AcmeHrSystemUser into a StoredUser (SCIM 2.0 User
 * with guaranteed `id` and `meta`).
 *
 * Enterprise extension is omitted entirely when all three fields are null —
 * avoids leaking empty objects to Okta's import (Pattern 1 §3 conditional
 * enterprise extension; okta-dialect.md §10 honesty about capabilities).
 */
export function acmeHrSystemToScim(native: AcmeHrSystemUser): StoredUser {
  const schemas: string[] = [USER_CORE_SCHEMA];

  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;
  if (hasEnterprise) {
    schemas.push(ENTERPRISE_SCHEMA);
  }

  // name — omit familyName entirely when sn is null (Madonna case).
  // See Pattern 1 §4 + okta-dialect.md §2 notes on null family names.
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
      // Acme HR System has only `lastModified` — approximate `created`
      // from the same field. Real targets with a separate `createdAt` column
      // should map it directly. okta-dialect.md §11.6 open item on timestamp
      // format: emit `YYYY-MM-DDTHH:mm:ssZ` (strip millis for safety).
      lastModified: stripMillis(native.lastModified),
      created: stripMillis(native.lastModified),
      location: `/scim/v2/Users/${native.uid}`,
    },
  };

  if (hasEnterprise) {
    const ent: Record<string, unknown> = {};
    if (native.employeeNumber !== null) ent.employeeNumber = native.employeeNumber;
    if (native.department !== null) ent.department = native.department;
    if (native.title !== null) ent.title = native.title;
    stored.extensions = { [ENTERPRISE_SCHEMA]: ent };
  }

  return stored;
}

// ── SCIM PATCH → Acme HR System PATCH ─────────────────────────────────────────

/**
 * Translate a SCIM PATCH Operations array into an AcmeHrSystemUserPatch.
 *
 * Supports the four PATCH shapes Okta emits per okta-dialect.md §1:
 *   1. replace, no path, value is an object  — e.g. {value:{active:false}}
 *   2. replace, path="active"                — deactivation / reactivation
 *   3. replace, path="name.givenName" etc.   — profile field update
 *   4. replace, path="emails[...].value"     — email update (best-effort extract)
 *
 * Unknown or unsupported paths are silently ignored (no-op) rather than
 * thrown. Rationale: RFC 7644 §3.5.2 requires atomicity across multi-op
 * PATCHes; allowing a single unknown path to abort the whole operation would
 * break Okta's compound PATCH payloads. The OIN-required deactivation path
 * (`active`) is explicitly handled — that is the critical gate.
 *
 * Only `replace` (and its capitalised variant "Replace") is processed.
 * Okta does not emit `add` or `remove` for user attribute updates; those
 * are group-push operations — okta-dialect.md §5.
 */
export function scimPatchToAcmeHrSystemPatch(
  ops: readonly ScimPatchOperation[],
): AcmeHrSystemUserPatch {
  const patch: AcmeHrSystemUserPatch = {};

  for (const op of ops) {
    // Normalise op name — scim-patch library may emit "Replace" (capitalised).
    const opLower = op.op.toLowerCase();
    if (opLower !== "replace") continue;

    if (!op.path) {
      // Shape 1: no path — value is a multi-field object.
      applyRootValueObject(op.value, patch);
    } else {
      // Shape 2/3/4: path-based.
      applyPathValue(op.path as string, op.value, patch);
    }
  }

  return patch;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

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
 * Strip milliseconds from an ISO-8601 timestamp, ensuring we emit
 * `YYYY-MM-DDTHH:mm:ssZ`. Conservative default per okta-dialect.md §11.6
 * open item on timestamp format.
 */
function stripMillis(iso: string): string {
  return iso.replace(/\.\d{1,3}Z$/, "Z");
}

function applyRootValueObject(value: unknown, patch: AcmeHrSystemUserPatch): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  if (typeof v.active === "boolean") {
    patch.enabled = v.active;
  }

  // Nested name object in root-value form.
  if (typeof v.name === "object" && v.name !== null) {
    const n = v.name as Record<string, unknown>;
    if (typeof n.givenName === "string") patch.givenName = n.givenName;
    if (typeof n.familyName === "string") patch.sn = n.familyName;
    if (typeof n.formatted === "string") patch.cn = n.formatted;
  }

  if (typeof v.displayName === "string") patch.cn = v.displayName;
  if (typeof v.title === "string") patch.title = v.title;
}

function applyPathValue(
  path: string,
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  // Normalise to lowercase for consistent matching.
  // okta-dialect.md §1 — Okta sends both `active` and `name.givenName`
  // style paths in replace operations.
  const p = path.toLowerCase();

  switch (p) {
    case "active":
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

    case "displayname":
      if (typeof value === "string") patch.cn = value;
      return;

    case "title":
      if (typeof value === "string") patch.title = value;
      return;

    case "department":
      if (typeof value === "string") patch.department = value;
      return;

    default:
      // Email filter-path: `emails[type eq "work"].value` — extract the
      // scalar value and update mail. Best-effort: handles the most common
      // shape Okta emits (okta-dialect.md §1 "replace with filter path").
      if (p.startsWith("emails[") && p.endsWith("].value")) {
        if (typeof value === "string") patch.mail = value;
        return;
      }
      // Unknown path — silent no-op. See header comment for rationale.
      return;
  }
}