/**
 * Attribute mapping between SCIM 2.0 (what Okta speaks) and Acme HR
 * System's native LDAP-shaped API. Pure functions — no I/O, no state,
 * testable in isolation.
 *
 * Dialect citations (Law 3 DIALECT-CITED):
 *   - uid-as-id convention:       okta-dialect.md §11.5 (externalId / id semantics)
 *   - Primary email wrapping:     RFC 7643 §4.1.2 (emails multi-value)
 *   - Enterprise extension:       RFC 7643 §4.3 (schema extensions)
 *   - PATCH op shapes handled:    okta-dialect.md §1 (all four shapes)
 *   - Sequential PATCH ops:       RFC 7644 §3.5.2
 *   - active ↔ enabled:           okta-dialect.md §3, §4
 *   - Single-token name (Madonna): pattern-1 §4 edge cases
 *
 * Mapping decisions:
 *   1. `uid` doubles as SCIM `id` AND `userName` (LDAP-backed SCIM convention).
 *      No separate id lookup table needed; dedup via userName eq uid filter
 *      works across the identity boundary.
 *   2. `cn` → `name.formatted`. If absent, compose from givenName + sn.
 *   3. Primary email wrapping: `mail` scalar → [{value, primary:true, type:"work"}].
 *   4. Enterprise extension included only when at least one field is non-null.
 *      Omitting an empty extension prevents Okta attribute-mapping misses
 *      (okta-dialect.md §10 — "don't advertise capacity you won't deliver").
 *   5. `lastModified` approximates `meta.created` (no separate createdAt in
 *      Acme HR System's API — okta-dialect.md §11.6 conservative default).
 *   6. PATCH: handles all four Okta shapes (replace-no-path, replace-with-path,
 *      add, remove). Unknown paths are silent no-ops per RFC 7644 §3.5.2
 *      atomicity — an unrecognised path in a multi-op PATCH must not abort
 *      the whole operation (see PATCH section below).
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

// ─────────────────────────────────────────────────────────────────────────────
// SCIM → Acme HR System (for create)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert an incoming SCIM User body (POST /Users) into the native create
 * payload for Acme HR System's API.
 *
 * Throws on missing required fields so the caller can surface a 400 before
 * hitting the network.
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
      "SCIM emails[primary].value is required — Acme HR System requires a mail field",
    );
  }

  const givenName = scim.name?.givenName ?? "";
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
    // active defaults to true per RFC 7643 §4.1.1 when not provided.
    enabled: scim.active ?? true,
    memberOf: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Acme HR System → SCIM (for read responses)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert an Acme HR System user record into a fully-formed SCIM StoredUser
 * for Okta to consume.
 *
 * `active: false` users ARE returned by this function — it's the store's
 * list() that filters them from unfiltered LIST responses (okta-dialect.md §4).
 */
export function acmeHrSystemToScim(native: AcmeHrSystemUser): StoredUser {
  const schemas: string[] = [USER_CORE_SCHEMA];

  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;

  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // Single-token name handling (Madonna case — pattern-1 §4):
  //   sn: null → omit familyName entirely (not emit null).
  //   cn used directly as formatted; fall back to composed value.
  const nameBlock: NonNullable<ScimUser["name"]> = {};
  if (native.givenName) nameBlock.givenName = native.givenName;
  if (native.sn !== null) nameBlock.familyName = native.sn;
  nameBlock.formatted = native.cn || composeCn(native.givenName, native.sn);

  const stored: StoredUser = {
    schemas,
    id: native.uid,
    userName: native.uid,
    name: nameBlock,
    emails: [{ value: native.mail, primary: true, type: "work" }],
    active: native.enabled,
    meta: {
      resourceType: "User",
      // Acme HR System exposes no separate createdAt — approximate with
      // lastModified per okta-dialect.md §11.6 conservative default.
      created: native.lastModified,
      lastModified: native.lastModified,
    },
  };

  if (hasEnterprise) {
    const ext: Record<string, unknown> = {};
    if (native.employeeNumber !== null) ext["employeeNumber"] = native.employeeNumber;
    if (native.department !== null) ext["department"] = native.department;
    if (native.title !== null) ext["title"] = native.title;
    stored.extensions = { [ENTERPRISE_SCHEMA]: ext };
  }

  return stored;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCIM PATCH ops → Acme HR System PATCH body
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a SCIM PatchOp Operations array into an Acme HR System PATCH
 * body. Handles all four Okta-emitted PATCH shapes per okta-dialect.md §1:
 *
 *   Shape A — replace, no path:   {op:"replace", value:{active:false}}
 *   Shape B — replace, path:      {op:"replace", path:"active", value:false}
 *   Shape C — add, multi-valued:  {op:"add", path:"emails", value:[...]}
 *   Shape D — remove, filter:     {op:"remove", path:"members[value eq \"x\"]"}
 *             (shape D is Group-only; in User context treat as no-op)
 *
 * Ops are applied sequentially per RFC 7644 §3.5.2. Unknown paths are silent
 * no-ops (not throws) so multi-op PATCHes with one unrecognised field don't
 * abort the entire operation (atomicity law — if you throw here the whole
 * request fails, which is worse than silently skipping an unmapped field).
 *
 * Lifecycle note (okta-dialect.md §3): Okta drives deactivation via PATCH
 * `active: false`. For soft-delete policy this translates to `enabled: false`.
 * The DELETE endpoint also produces `enabled: false` — see store.ts.
 */
export function scimPatchToAcmeHrSystemPatch(
  ops: readonly ScimPatchOperation[],
): AcmeHrSystemUserPatch {
  const patch: AcmeHrSystemUserPatch = {};

  for (const op of ops) {
    const opLower = op.op.toLowerCase();

    if (opLower === "replace" || opLower === "add") {
      if (!op.path) {
        // Shape A — value is a plain object, apply each known field.
        applyValueObject(op.value, patch);
      } else {
        // Shape B / C — path-targeted replace or add.
        applyPathValue(String(op.path), op.value, patch);
      }
    }
    // Shape D (remove with filter path) — only meaningful for Group members;
    // on a User resource treat as no-op. We do not throw so the PATCH stays
    // atomic across a multi-op payload that might mix User and Group ops.
  }

  return patch;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function pickPrimaryEmail(emails: ScimEmail[] | undefined): string | null {
  if (!emails || emails.length === 0) return null;
  const primary = emails.find((e) => e.primary === true);
  return (primary ?? emails[0])!.value;
}

function composeCn(givenName: string, sn: string | null): string {
  if (!sn) return givenName.trim();
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

/** Shape A — root-level value object with multiple attribute keys. */
function applyValueObject(value: unknown, patch: AcmeHrSystemUserPatch): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  // active ↔ enabled — the primary deactivation path (okta-dialect.md §3, §4).
  if (typeof v["active"] === "boolean") patch.enabled = v["active"];

  // Flat name fields embedded in the root object.
  if (typeof v["name"] === "object" && v["name"] !== null) {
    const n = v["name"] as Record<string, unknown>;
    if (typeof n["givenName"] === "string") patch.givenName = n["givenName"];
    if (typeof n["familyName"] === "string") patch.sn = n["familyName"];
    if (typeof n["formatted"] === "string") patch.cn = n["formatted"];
  }

  // Flat scalar fields.
  if (typeof v["title"] === "string") patch.title = v["title"];
  if (typeof v["department"] === "string") patch.department = v["department"];

  // Emails — pick primary and update mail.
  if (Array.isArray(v["emails"])) {
    const mail = pickPrimaryEmail(v["emails"] as ScimEmail[]);
    if (mail) patch.mail = mail;
  }
}

/** Shape B/C — explicit path-targeted value. */
function applyPathValue(
  path: string,
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  // Normalise to lowercase for case-insensitive path matching.
  const normalised = path.toLowerCase();

  switch (normalised) {
    case "active":
      // Deactivation via path — okta-dialect.md §3, §4.
      if (typeof value === "boolean") patch.enabled = value;
      break;

    case "name.givenname":
      if (typeof value === "string") patch.givenName = value;
      break;

    case "name.familyname":
      // Nullable — explicit null clears sn (single-token name promotion).
      if (typeof value === "string") patch.sn = value;
      if (value === null) patch.sn = null;
      break;

    case "name.formatted":
      if (typeof value === "string") patch.cn = value;
      break;

    case "title":
      if (typeof value === "string") patch.title = value;
      break;

    case "department":
      if (typeof value === "string") patch.department = value;
      break;

    case "emails":
      // Shape C — add/replace email array.
      if (Array.isArray(value)) {
        const mail = pickPrimaryEmail(value as ScimEmail[]);
        if (mail) patch.mail = mail;
      }
      break;

    case "username":
      // userName is immutable in Acme HR System (uid is the PK).
      // Silent no-op — okta-dialect.md §11.5 warns ID drift breaks dedup.
      break;

    default:
      // Unknown path — silent no-op per RFC 7644 §3.5.2 atomicity rationale
      // in the function header.
      break;
  }
}