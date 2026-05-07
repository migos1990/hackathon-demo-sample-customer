/**
 * Attribute mapping between SCIM 2.0 (Okta) and the Acme HR System's
 * LDAP-shaped native API. Pure functions — no I/O, no state, testable in
 * isolation.
 *
 * Implements the LDAP source pattern from docs/patterns/ldap.md §2-§4.
 *
 * Mapping decisions:
 *   - `uid` doubles as SCIM `id` AND `userName` (LDAP-backed convention).
 *   - Single-token names: `sn: null` ↔ `name.familyName` omitted entirely
 *     rather than emitting null. Tested as the "Madonna case".
 *   - Enterprise extension (employeeNumber, department, title) omitted from
 *     `schemas[]` when all three fields are null — avoids empty-object leakage.
 *   - Primary email wrapping: `mail` scalar → [{value, primary:true, type:"work"}].
 *   - `lastModified` doubles as `meta.created` (source has no separate
 *     createdAt; approximated per docs/patterns/ldap.md §2 mapping decisions).
 *   - PATCH ops supported: root-replace `{active:...}`, path-replace `active`,
 *     `name.givenName`, `name.familyName`, `name.formatted`, `title`,
 *     `emails[type eq "work"].value`. Unknown paths are silently no-op'd
 *     (RFC 7644 §3.5.2 atomicity — a single unknown path must not abort the
 *     whole multi-op PATCH).
 *   - Lifecycle_policy=soft_delete: scimPatchToNativePatch emits
 *     `{enabled: false}` for active:false — the DELETE handler also produces
 *     this patch rather than issuing a hard delete.
 *     Per okta-dialect.md §3 and RFC 7643 §4.1.1.
 *
 * Ticket: OKT-10
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

// ---------------------------------------------------------------------------
// SCIM → Acme HR System (create)
// ---------------------------------------------------------------------------

/**
 * Translate a SCIM User POST body into the native create shape.
 *
 * Throws (not returns an error) when required fields are absent so the
 * caller (store.create) can surface a clean 400/422 to the SCIM route.
 */
export function scimToNativeCreate(
  scim: Omit<ScimUser, "id" | "meta">,
): AcmeHrSystemUserCreate {
  if (!scim.userName) {
    throw new Error(
      "SCIM userName is required — Acme HR uses it as uid (primary key)",
    );
  }

  const mail = pickPrimaryEmail(scim.emails);
  if (!mail) {
    throw new Error(
      "SCIM emails[primary].value is required — Acme HR requires a mail value",
    );
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

// ---------------------------------------------------------------------------
// Acme HR System → SCIM (read / list)
// ---------------------------------------------------------------------------

/**
 * Translate a native AcmeHrSystemUser into a StoredUser (SCIM 2.0 shape
 * with guaranteed `id` and `meta`).
 *
 * Per okta-dialect.md §4: active:false users are valid stored users; callers
 * may filter them from default list responses. The mapping itself is
 * policy-neutral — the store layer applies the active-visibility rule.
 */
export function nativeToScim(native: AcmeHrSystemUser): StoredUser {
  const schemas = [USER_CORE_SCHEMA];

  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;
  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // Single-token name (Madonna case): omit familyName rather than emit null.
  // Per docs/patterns/ldap.md §4 "Single-token name handling".
  const name: {
    givenName?: string;
    familyName?: string;
    formatted?: string;
  } = {};
  if (native.givenName) name.givenName = native.givenName;
  if (native.sn !== null) name.familyName = native.sn;
  if (native.cn) name.formatted = native.cn;

  const stored: StoredUser = {
    schemas,
    id: native.uid,
    userName: native.uid,
    name,
    displayName: native.cn || undefined,
    emails: [{ value: native.mail, primary: true, type: "work" }],
    active: native.enabled,
    meta: {
      resourceType: "User",
      // AcmeHR has no separate createdAt; approximate with lastModified.
      // Per docs/patterns/ldap.md §2 "lastModified doubles as meta.created".
      created: native.lastModified,
      lastModified: native.lastModified,
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
// SCIM PATCH → Acme HR System PATCH
// ---------------------------------------------------------------------------

/**
 * Translate SCIM PatchOperations into a native AcmeHrSystemUserPatch.
 *
 * Handles the four PATCH shapes Okta emits per okta-dialect.md §1:
 *   1. replace unscoped — {op:"replace", value:{active:false}}
 *   2. replace with simple path — {op:"replace", path:"active", value:false}
 *   3. replace with filter-path — {op:"replace", path:'emails[type eq "work"].value', value:"new@..."}
 *   4. add multi-valued — {op:"add", path:"emails", value:[{...}]}
 *
 * Ops are applied sequentially per RFC 7644 §3.5.2 (order matters for
 * multi-op PATCH correctness — okta-dialect.md §1 "PATCH ordering bugs").
 *
 * Unknown/unsupported paths are silently no-op'd. This is intentional per
 * RFC 7644 §3.5.2 atomicity reasoning: a single unknown extension field
 * must not abort an otherwise-valid multi-op PATCH.
 *
 * Lifecycle_policy=soft_delete (OKT-10): `active:false` maps to
 * `{enabled:false}`, never to a delete instruction.
 * Per okta-dialect.md §3 and §4.
 */
export function scimPatchToNativePatch(
  ops: readonly ScimPatchOperation[],
): AcmeHrSystemUserPatch {
  const patch: AcmeHrSystemUserPatch = {};

  for (const op of ops) {
    const opLower = (op.op as string).toLowerCase();

    if (opLower === "replace") {
      if (!op.path) {
        // Shape 1: root replace — value is an object map of attrs.
        applyValueObject(op.value, patch);
      } else {
        // Shape 2 & 3: path-targeted replace.
        applyPathValue(String(op.path), op.value, patch);
      }
    } else if (opLower === "add") {
      if (op.path) {
        // Shape 4: add to a multi-valued attribute (e.g. update primary email).
        applyPathValue(String(op.path), op.value, patch);
      } else {
        // Root-level add without path behaves like replace per RFC 7644 §3.5.2.
        applyValueObject(op.value, patch);
      }
    }
    // op:remove is handled upstream (scim-patch library applies it to the
    // SCIM resource; we only translate replace/add into native patch ops).
  }

  return patch;
}

function applyValueObject(value: unknown, patch: AcmeHrSystemUserPatch): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  // Per okta-dialect.md §4: active is the primary lifecycle signal.
  if (typeof v["active"] === "boolean") patch.enabled = v["active"];

  if (typeof v["name"] === "object" && v["name"] !== null) {
    const n = v["name"] as Record<string, unknown>;
    if (typeof n["givenName"] === "string") patch.givenName = n["givenName"];
    if (typeof n["familyName"] === "string") patch.sn = n["familyName"];
    if (typeof n["formatted"] === "string") patch.cn = n["formatted"];
  }

  // Inline email update: {emails: [{value:"x", primary:true, type:"work"}]}
  if (Array.isArray(v["emails"])) {
    const primary = (v["emails"] as ScimEmail[]).find((e) => e.primary === true);
    if (primary?.value) patch.mail = primary.value;
  }
}

function applyPathValue(
  path: string,
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  // Normalise to lowercase for case-insensitive path comparison.
  const p = path.toLowerCase().trim();

  switch (p) {
    case "active":
      // okta-dialect.md §4 + §3: the primary deprovisioning signal.
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
      // Map displayName → cn (best approximation in LDAP model).
      if (typeof value === "string") patch.cn = value;
      break;

    case "title":
      if (typeof value === "string") patch.title = value;
      break;

    case "emails":
      // Add/replace the emails array — pick primary.
      if (Array.isArray(value)) {
        const primary = (value as ScimEmail[]).find((e) => e.primary === true);
        if (primary?.value) patch.mail = primary.value;
      }
      break;

    default:
      // Filter-path form: emails[type eq "work"].value
      // Per okta-dialect.md §1 "replace with filter path" shape.
      if (p.startsWith('emails[') && p.endsWith('].value')) {
        if (typeof value === "string") patch.mail = value;
      }
      // All other unknown paths: silent no-op. Per mapping header comment.
      break;
  }
}