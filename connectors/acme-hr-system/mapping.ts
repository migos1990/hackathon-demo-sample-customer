/**
 * Attribute mapping between SCIM 2.0 (what Okta speaks) and the Acme HR
 * System's native LDAP-shaped API. Pure functions — no I/O, no state.
 *
 * Mapping decisions (each choice is justified below and tested in
 * mapping.test.ts):
 *
 *   - `uid` doubles as both SCIM `id` AND `userName` (LDAP-backed SCIM
 *     convention per docs/patterns/ldap.md §2).
 *   - Single-token names (sn=null) round-trip cleanly: `familyName` is
 *     omitted from the SCIM output entirely rather than emitting null
 *     (some Okta consumers reject null family names).
 *   - Enterprise extension is conditionally included: the
 *     `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User` URN is
 *     only pushed into `schemas[]` when at least one enterprise field is
 *     non-null. An empty extension object is a lie about the resource and
 *     can break Okta attribute mappings (okta-dialect.md §11).
 *   - Lifecycle policy is `soft_delete` (OKT-10): `active: false` maps to
 *     `enabled: false` on the target; the row is never deleted.
 *     See okta-dialect.md §3 and §4.
 *   - PATCH translation handles the four Okta-emitted shapes documented in
 *     okta-dialect.md §1: root-value replace, path-based replace for active
 *     and name.*, and remove ops (treated as no-ops for scalar fields where
 *     removal has no target-side representation).
 *   - `lastModified` approximates `meta.created` when the target exposes
 *     only one timestamp (same as reference connector — see mapping.ts note
 *     in connectors/acme-hr/mapping.ts).
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

// ─── SCIM → Native (create) ───────────────────────────────────────────────

/**
 * Translate a SCIM User POST body into the Acme HR System create payload.
 *
 * Throws if `userName` or a primary email is absent — both are required by
 * the target (uid is the primary key; mail is mandatory for employee records).
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
      "SCIM emails[primary=true].value is required — Acme HR System requires a mail value",
    );
  }

  const givenName = scim.name?.givenName ?? "";
  const sn = scim.name?.familyName ?? null;
  const cn = scim.name?.formatted ?? composeCn(givenName, sn);

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
    // RFC 7643 §4.1.1: active absent → default true.
    enabled: scim.active ?? true,
    memberOf: [],
  };
}

// ─── Native → SCIM (read) ─────────────────────────────────────────────────

/**
 * Translate an Acme HR System user record into a SCIM StoredUser.
 *
 * Enterprise extension is conditionally included per the mapping decision
 * documented in docs/patterns/ldap.md §2 ("Enterprise extension, conditional").
 *
 * `meta.created` is approximated from `lastModified` because the target
 * exposes only one timestamp. See okta-dialect.md §11.6 for the timestamp
 * format choice (no fractional seconds, UTC Z suffix).
 */
export function acmeHrSystemToScim(native: AcmeHrSystemUser): StoredUser {
  const schemas: string[] = [USER_CORE_SCHEMA];

  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;
  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // Single-token name handling (Madonna case): omit familyName entirely when
  // sn is null rather than emitting `familyName: null`.
  // See docs/patterns/ldap.md §4 and okta-dialect.md §11.1.
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
      // okta-dialect.md §11.6: emit ISO 8601 without fractional seconds, UTC Z.
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

// ─── SCIM PATCH → Native PATCH ────────────────────────────────────────────

/**
 * Translate SCIM PATCH Operations into an Acme HR System patch payload.
 *
 * Handles the four Okta-emitted PATCH shapes per okta-dialect.md §1:
 *   1. `{op:"replace", value:{active:false}}` — root-value object (most
 *      common deactivation form — okta-dialect.md §1 table row 1)
 *   2. `{op:"replace", path:"active", value:false}` — path-based scalar
 *   3. `{op:"replace", path:"name.givenName", value:"..."}` — nested path
 *   4. `{op:"remove", path:"members[value eq \"...\"]"}` — group remove
 *      (no-op here — groups not in scope for OKT-10)
 *
 * Unknown / unsupported paths are silently ignored per RFC 7644 §3.5.2
 * atomicity: an unknown path in a multi-op PATCH MUST NOT abort the whole
 * operation. The caller (store.patch) applies all ops atomically via
 * scim-patch before calling this function for the target-side translation.
 *
 * Lifecycle policy = soft_delete (OKT-10): `active: false` → `enabled: false`.
 * The row is never deleted on the target. See okta-dialect.md §3.
 */
export function scimPatchToAcmeHrSystemPatch(
  ops: readonly ScimPatchOperation[],
): AcmeHrSystemUserPatch {
  const patch: AcmeHrSystemUserPatch = {};

  for (const op of ops) {
    const opLower = op.op.toLowerCase();

    if (opLower === "replace") {
      if (!op.path) {
        // Shape 1: root-value object — extract known fields.
        applyRootValueObject(op.value, patch);
      } else {
        // Shape 2/3: path-based replace.
        applyPathReplace(op.path, op.value, patch);
      }
    } else if (opLower === "add") {
      // add without path: treat value object same as replace (idempotent
      // for scalar fields — RFC 7644 §3.5.2 "add" semantics).
      if (!op.path) {
        applyRootValueObject(op.value, patch);
      }
      // add with path targeting a scalar attr (e.g. "active") — treat as replace.
      else {
        applyPathReplace(op.path, op.value, patch);
      }
    }
    // `remove` on scalar fields has no meaningful target-side representation;
    // silently skip. Group member removes are also no-ops here (OKT-10 scope).
  }

  return patch;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

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
 * Apply a root-value PATCH object (Shape 1) to the running patch accumulator.
 * Handles `active`, `name.*`, and top-level scalars that map 1-1 to native fields.
 */
function applyRootValueObject(
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  // active → enabled (soft_delete policy: okta-dialect.md §3 + §4)
  if (typeof v["active"] === "boolean") patch.enabled = v["active"];

  // Nested name object in root value form
  if (typeof v["name"] === "object" && v["name"] !== null) {
    const n = v["name"] as Record<string, unknown>;
    if (typeof n["givenName"] === "string") patch.givenName = n["givenName"];
    if (typeof n["familyName"] === "string") patch.sn = n["familyName"];
    if (typeof n["formatted"] === "string") patch.cn = n["formatted"];
  }

  if (typeof v["displayName"] === "string") patch.cn = v["displayName"];
  if (typeof v["title"] === "string") patch.title = v["title"];

  // email update in root-value form: pick primary if present
  if (Array.isArray(v["emails"])) {
    const mail = pickPrimaryEmail(v["emails"] as ScimEmail[]);
    if (mail) patch.mail = mail;
  }
}

/**
 * Apply a path-based PATCH replace/add op (Shape 2/3).
 * path is lowercased before the switch so "active" and "Active" both match.
 */
function applyPathReplace(
  path: string,
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  // Strip filter predicates for multi-value paths like
  // `emails[type eq "work"].value` → we just want the leaf attr.
  // Full filter-path parsing is out of scope; we handle the OIN-gating
  // subset per okta-dialect.md §1.
  const normalized = path.toLowerCase();

  switch (normalized) {
    case "active":
      // Deactivation / reactivation — soft_delete policy (okta-dialect.md §3):
      // sets enabled; never triggers a hard delete on the target.
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
      // Path-based email replace: value is an array of ScimEmail objects.
      if (Array.isArray(value)) {
        const mail = pickPrimaryEmail(value as ScimEmail[]);
        if (mail) patch.mail = mail;
      }
      break;

    default:
      // Handle `emails[type eq "work"].value` pattern — extract the
      // `.value` leaf from a filtered multi-value path.
      if (
        normalized.startsWith("emails[") &&
        normalized.endsWith("].value") &&
        typeof value === "string"
      ) {
        patch.mail = value;
      }
      // All other paths are silently ignored per RFC 7644 §3.5.2 atomicity.
      // Unknown paths MUST NOT abort a multi-op PATCH. See mapping header.
      break;
  }
}

/**
 * Strip fractional seconds from an ISO 8601 timestamp and ensure UTC Z suffix.
 * okta-dialect.md §11.6 (OPEN item): conservative default — no millis, UTC Z.
 * Input: "2026-05-05T14:22:00.000Z" → Output: "2026-05-05T14:22:00Z"
 */
function stripMillis(iso: string): string {
  return iso.replace(/\.\d+Z$/, "Z").replace(/\.\d+([+-]\d{2}:\d{2})$/, "$1");
}