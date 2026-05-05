/**
 * Attribute mapping between SCIM 2.0 (what Okta speaks) and AcmeHR's
 * native LDAP-shaped API. Pure functions — no I/O, no state, trivially
 * testable.
 *
 * This file is the SINGLE LARGEST CONTRIBUTOR to connector tribal knowledge.
 * What the AI agent generates per customer is essentially this file's
 * equivalent for the customer's target app. Get this right, and the agent
 * has a concrete reference to imitate.
 *
 * Mapping decisions (tested in mapping.test.ts):
 *   - AcmeHR `uid` doubles as the SCIM `id` (LDAP-backed SCIM convention).
 *   - Primary email → `mail` (falls back to first email if no primary).
 *   - Single-token names round-trip cleanly (`sn: null` ↔ `familyName: undefined`).
 *   - Enterprise extension fields (employeeNumber, department) are optional
 *     on both sides. Skipped when all null.
 *   - PATCH ops: replace-at-root `{active: ...}` AND path-based
 *     `replace active`, `replace name.givenName` supported (the OIN-gating
 *     subset). Unsupported targets are silently ignored, NOT thrown — PATCH
 *     atomicity per RFC 7644 §3.5.2 means partial-success semantics need
 *     explicit design; for now, unknown paths are a no-op.
 */
import type { ScimUser, StoredUser, ScimEmail } from "../../skeleton/types.js";
import type { ScimPatchOperation } from "scim-patch";
import type {
  AcmeHrUser,
  AcmeHrUserCreate,
  AcmeHrUserPatch,
} from "../../demo-targets/acme-hr-lite/types.js";

export const ENTERPRISE_SCHEMA = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const USER_CORE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

// --- SCIM → AcmeHR (create) ---

export function scimToAcmeHrCreate(scim: Omit<ScimUser, "id" | "meta">): AcmeHrUserCreate {
  if (!scim.userName) {
    throw new Error("SCIM userName is required — AcmeHR uses it as uid (primary key)");
  }
  const mail = pickPrimaryEmail(scim.emails);
  if (!mail) {
    throw new Error("SCIM emails is required — AcmeHR requires a mail value");
  }

  const givenName = scim.name?.givenName ?? "";
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
    employeeNumber: typeof e.employeeNumber === "string" ? e.employeeNumber : null,
    department: typeof e.department === "string" ? e.department : null,
    title: typeof e.title === "string" ? e.title : null,
  };
}

// --- AcmeHR → SCIM (read) ---

export function acmeHrToScim(acme: AcmeHrUser): StoredUser {
  const schemas = [USER_CORE_SCHEMA];

  const hasEnterprise =
    acme.employeeNumber !== null || acme.department !== null || acme.title !== null;
  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  const name: { givenName?: string; familyName?: string; formatted?: string } = {};
  if (acme.givenName) name.givenName = acme.givenName;
  if (acme.sn !== null) name.familyName = acme.sn;
  if (acme.cn) name.formatted = acme.cn;

  const stored: StoredUser = {
    schemas,
    id: acme.uid,
    userName: acme.uid,
    name,
    emails: [{ value: acme.mail, primary: true, type: "work" }],
    active: acme.enabled,
    meta: {
      resourceType: "User",
      lastModified: acme.lastModified,
      // AcmeHR stores only lastModified — approximate created as same. Real
      // customers with a separate `createdAt` column map it directly.
      created: acme.lastModified,
    },
  };

  if (hasEnterprise) {
    const ent: Record<string, unknown> = {};
    if (acme.employeeNumber !== null) ent.employeeNumber = acme.employeeNumber;
    if (acme.department !== null) ent.department = acme.department;
    if (acme.title !== null) ent.title = acme.title;
    stored.extensions = { [ENTERPRISE_SCHEMA]: ent };
  }

  return stored;
}

// --- SCIM PATCH → AcmeHR PATCH ---

export function scimPatchToAcmeHrPatch(ops: readonly ScimPatchOperation[]): AcmeHrUserPatch {
  const patch: AcmeHrUserPatch = {};

  for (const op of ops) {
    if (op.op !== "replace" && op.op !== "Replace") continue;

    // Case A: no path — `value` is an object with multiple attrs.
    if (!op.path) {
      applyValueObject(op.value, patch);
      continue;
    }

    // Case B: path-based.
    applyPathValue(op.path, op.value, patch);
  }

  return patch;
}

function applyValueObject(value: unknown, patch: AcmeHrUserPatch): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;
  if (typeof v.active === "boolean") patch.enabled = v.active;
  // name.* via nested object is legal in root-value form too.
  if (typeof v.name === "object" && v.name !== null) {
    const n = v.name as Record<string, unknown>;
    if (typeof n.givenName === "string") patch.givenName = n.givenName;
    if (typeof n.familyName === "string") patch.sn = n.familyName;
    if (typeof n.formatted === "string") patch.cn = n.formatted;
  }
}

function applyPathValue(path: string, value: unknown, patch: AcmeHrUserPatch): void {
  const normalized = path.toLowerCase();
  switch (normalized) {
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
    case "title":
      if (typeof value === "string") patch.title = value;
      return;
    default:
      // Unknown path — silent no-op. See header comment for rationale.
      return;
  }
}
