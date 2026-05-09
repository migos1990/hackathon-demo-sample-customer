/**
 * Attribute mapping: SCIM 2.0 (Okta) ↔ AcmeCorpQ3 native LDAP-shaped API.
 *
 * Pure functions — no I/O, no state, trivially testable. The SCIM
 * connector's highest-value and most fragile layer.
 *
 * Key decisions (all tested, none magic):
 *
 *   1. uid doubles as SCIM id AND userName (LDAP convention).
 *      okta-dialect.md §11.5: externalId stores the SCIM server's ID on Okta's
 *      side. We use uid for both SCIM id and externalId to prevent drift on
 *      reactivation or migration.
 *
 *   2. sn:null → omit name.familyName (the "Madonna case").
 *      Okta consumers reject null familyName in some attribute-mapping flows.
 *      See pattern ldap.md §4.
 *
 *   3. Enterprise extension only when at least one field is non-null.
 *      Emitting an empty extension object causes Okta attribute-mapping
 *      failures in some tenants. See pattern ldap.md §2.
 *
 *   4. PATCH → native patch translation handles all four Okta PATCH shapes:
 *      - replace unscoped   ({"op":"replace","value":{"active":false}})
 *      - replace with path  ({"op":"replace","path":"active","value":false})
 *      - add multi-valued   (handled defensively — not a primary flow here)
 *      - remove with filter (group member removal — not applicable for users)
 *      per okta-dialect.md §1 and RFC 7644 §3.5.2.
 *
 *   5. Soft-delete policy (ticket OKT-57 lifecycle_policy=soft_delete):
 *      active:false → enabled:false. Row NEVER deleted. Same outcome for
 *      both PATCH-deactivate and DELETE per okta-dialect.md §3.
 *
 *   6. Reactivation (PATCH active:true) sets enabled:true. No attribute
 *      clearing is configured for this ticket so the empty-profile problem
 *      described in okta-dialect.md §4 does not apply.
 *
 *   7. meta.lastModified emitted without fractional seconds per
 *      okta-dialect.md §11.6 conservative default (YYYY-MM-DDTHH:mm:ssZ).
 */

import type { ScimUser, StoredUser, ScimEmail } from "../../skeleton/types.js";
import type { ScimPatchOperation } from "scim-patch";
import type {
  AcmeCorpQ3User,
  AcmeCorpQ3UserCreate,
  AcmeCorpQ3UserPatch,
} from "./types.js";

// ─── Schema constants ───────────────────────────────────────────────────────

export const ENTERPRISE_SCHEMA =
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const USER_CORE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

// ─── SCIM → AcmeCorpQ3 (create) ─────────────────────────────────────────────

/**
 * Translate an incoming SCIM POST /Users body into the native create shape.
 *
 * Throws a descriptive Error (not a SCIM envelope — the route layer wraps
 * it) when required fields are missing.
 */
export function scimToAcmeCorpQ3Create(
  scim: Omit<ScimUser, "id" | "meta">,
): AcmeCorpQ3UserCreate {
  if (!scim.userName || scim.userName.trim() === "") {
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
    scim.name?.formatted ??
    composeCn(givenName, sn);

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
    // active defaults to true per RFC 7643 §4.1.1 — absence means active.
    // okta-dialect.md §4: Okta doesn't pull in users with active=false.
    enabled: scim.active ?? true,
    memberOf: [],
  };
}

// ─── AcmeCorpQ3 → SCIM (read) ────────────────────────────────────────────────

/**
 * Translate a native AcmeCorpQ3 user into a SCIM StoredUser.
 *
 * Decision: uid is used as both SCIM id and userName. externalId is also set
 * to uid so Okta can correlate the resource across import cycles without
 * drift (okta-dialect.md §11.5).
 */
export function acmeCorpQ3ToScim(native: AcmeCorpQ3User): StoredUser {
  const schemas: string[] = [USER_CORE_SCHEMA];

  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;
  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // Build name object, omitting undefined/null fields cleanly.
  // sn:null → omit familyName (Madonna case — see header comment #2).
  const name: NonNullable<ScimUser["name"]> = {};
  if (native.givenName) name.givenName = native.givenName;
  if (native.sn !== null) name.familyName = native.sn;
  // name.formatted: prefer cn; fall back to composition.
  name.formatted = native.cn || composeCn(native.givenName, native.sn);

  // Primary email wrapping: mail is scalar in LDAP, multi-value in SCIM.
  // okta-dialect.md §10 / pattern ldap.md §2: wrap with primary:true, type:work.
  const emails: ScimEmail[] = [
    { value: native.mail, primary: true, type: "work" },
  ];

  const stored: StoredUser = {
    schemas,
    id: native.uid,
    externalId: native.uid, // okta-dialect.md §11.5 — prevent drift
    userName: native.uid,
    name,
    emails,
    active: native.enabled,
    meta: {
      resourceType: "User",
      // AcmeCorpQ3 has no separate createdAt — approximate with lastModified.
      // Documented in RUNBOOK.md §Known Limitations.
      created: stripMillis(native.lastModified),
      lastModified: stripMillis(native.lastModified),
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
 * Translate SCIM PATCH Operations into a native patch object.
 *
 * Handles the four Okta PATCH shapes per okta-dialect.md §1:
 *   A) replace unscoped: {"op":"replace","value":{"active":false,...}}
 *   B) replace with path: {"op":"replace","path":"active","value":false}
 *   C) add (multi-valued): handled defensively for emails
 *   D) remove with filter path: not applicable for user scalar fields
 *
 * Ops are applied sequentially (RFC 7644 §3.5.2 — "server MUST apply all
 * Operations atomically" in document order). The caller (store.patch) is
 * responsible for atomicity at the API-call level.
 *
 * Soft-delete policy: active:false → enabled:false. Never emits a delete.
 * Reactivation: active:true → enabled:true (okta-dialect.md §4 — idempotent).
 *
 * Unknown paths are silently ignored (not thrown) so that a multi-op PATCH
 * containing one unknown path does not abort all other ops. RFC 7644 §3.5.2
 * requires atomicity of the whole set; we treat unknown-path as a no-op
 * rather than an error to be maximally interoperable with Okta's evolving
 * attribute set.
 */
export function scimPatchToAcmeCorpQ3Patch(
  ops: readonly ScimPatchOperation[],
): AcmeCorpQ3UserPatch {
  const patch: AcmeCorpQ3UserPatch = {};

  for (const op of ops) {
    const opLower = (op.op ?? "").toLowerCase();

    if (opLower === "replace") {
      if (!op.path) {
        // Shape A: unscoped replace — value is an attribute map.
        applyUnscoped(op.value, patch);
      } else {
        // Shape B: path-based replace.
        applyPathValue(op.path, op.value, patch);
      }
    } else if (opLower === "add") {
      // Shape C: add — treat like replace for scalar fields; for multi-valued
      // (emails, memberOf) append semantics apply but are not primary flows.
      if (!op.path) {
        applyUnscoped(op.value, patch);
      } else {
        applyPathValue(op.path, op.value, patch);
      }
    }
    // Shape D: remove — not applicable for user scalars; group member removal
    // is handled by the Groups endpoint (not yet implemented per ticket OKT-57).
    // Silent no-op for remove ops here.
  }

  return patch;
}

/**
 * Build a soft-delete patch — used when DELETE /Users/:id is received.
 *
 * Per okta-dialect.md §3 soft_delete policy: DELETE handler and PATCH
 * active:false handler MUST produce the same end-state. This helper is
 * the single source of truth for that end-state so both handlers call it.
 */
export function buildSoftDeletePatch(): AcmeCorpQ3UserPatch {
  return { enabled: false };
}

// ─── Private helpers ─────────────────────────────────────────────────────────

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
    employeeNumber: typeof e["employeeNumber"] === "string" ? e["employeeNumber"] : null,
    department: typeof e["department"] === "string" ? e["department"] : null,
    title: typeof e["title"] === "string" ? e["title"] : null,
  };
}

/**
 * Strip fractional seconds from an ISO-8601 timestamp.
 * Conservative default per okta-dialect.md §11.6 (OPEN item):
 * emit YYYY-MM-DDTHH:mm:ssZ, no millis, UTC Z suffix.
 */
function stripMillis(iso: string): string {
  return iso.replace(/\.\d+Z$/, "Z");
}

function applyUnscoped(value: unknown, patch: AcmeCorpQ3UserPatch): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  if (typeof v["active"] === "boolean") patch.enabled = v["active"];

  if (typeof v["name"] === "object" && v["name"] !== null) {
    const n = v["name"] as Record<string, unknown>;
    if (typeof n["givenName"] === "string") patch.givenName = n["givenName"];
    if (typeof n["familyName"] === "string") patch.sn = n["familyName"];
    if (typeof n["formatted"] === "string") patch.cn = n["formatted"];
  }

  if (typeof v["displayName"] === "string") patch.cn = v["displayName"];

  // Email update via unscoped replace — pick primary from the array.
  if (Array.isArray(v["emails"])) {
    const emails = v["emails"] as Array<Record<string, unknown>>;
    const primary = emails.find((e) => e["primary"] === true) ?? emails[0];
    if (primary && typeof primary["value"] === "string") {
      patch.mail = primary["value"];
    }
  }

  // Enterprise extension inside unscoped replace.
  const ent = (v[ENTERPRISE_SCHEMA] ?? v["extensions"]?.[ENTERPRISE_SCHEMA]) as
    | Record<string, unknown>
    | undefined;
  if (ent && typeof ent === "object") {
    if (typeof ent["employeeNumber"] === "string") patch.employeeNumber = ent["employeeNumber"];
    if (typeof ent["department"] === "string") patch.department = ent["department"];
    if (typeof ent["title"] === "string") patch.title = ent["title"];
  }
}

function applyPathValue(
  path: string,
  value: unknown,
  patch: AcmeCorpQ3UserPatch,
): void {
  // Normalise path for comparison but preserve original for complex filter
  // paths (emails[type eq "work"].value) where we need the bracket part.
  const norm = path.toLowerCase().trim();

  switch (norm) {
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

    case `${ENTERPRISE_SCHEMA.toLowerCase()}:employeenumber`:
    case "enterpriseuser.employeenumber":
    case "employeenumber":
      if (typeof value === "string") patch.employeeNumber = value;
      return;

    case `${ENTERPRISE_SCHEMA.toLowerCase()}:department`:
    case "enterpriseuser.department":
    case "department":
      if (typeof value === "string") patch.department = value;
      return;

    case `${ENTERPRISE_SCHEMA.toLowerCase()}:title`:
    case "enterpriseuser.title":
      if (typeof value === "string") patch.title = value;
      return;

    default:
      // Complex filter path for email: emails[type eq "work"].value
      // okta-dialect.md §1 shape: {"op":"replace","path":"emails[type eq \"work\"].value","value":"new@..."}
      if (norm.startsWith("emails[") && norm.endsWith("].value")) {
        if (typeof value === "string") patch.mail = value;
        return;
      }
      // Unknown path — silent no-op per header comment.
      return;
  }
}