/**
 * Attribute mapping: SCIM 2.0 ↔ Acme HR System (LDAP-shaped).
 *
 * Pure functions — no I/O, no side effects, deterministic. Every transform
 * has a corresponding unit test in mapping.test.ts.
 *
 * Mapping decisions (all field-confirmed against the LDAP pattern —
 * see docs/patterns/ldap.md §2):
 *
 *   - `uid` doubles as both SCIM `id` AND `userName`. Standard LDAP-backed
 *     SCIM convention; avoids a separate id-lookup table and keeps
 *     dedup-filter + get-by-id round-trips stable.
 *     (okta-dialect.md §11.5 — externalId semantics)
 *
 *   - `sn: null` → SCIM `name.familyName` is OMITTED (not emitted as null).
 *     Okta consumers are not required to handle null family names and some
 *     reject. "Madonna case" test in mapping.test.ts.
 *     (docs/patterns/ldap.md §4)
 *
 *   - Enterprise extension included in `schemas[]` ONLY when at least one
 *     enterprise field is non-null. Emitting an empty extension object
 *     is a lie about what the resource has and breaks some Okta attribute
 *     mappings. (docs/patterns/ldap.md §2 mapping decision 3)
 *
 *   - `lastModified` approximates `meta.created` (no separate createdAt
 *     in the Acme HR System API). See §11.6 [OPEN] on timestamp format —
 *     we strip milliseconds and emit UTC Z per the conservative default.
 *
 *   - PATCH translation covers the OIN-gating subset of ops:
 *       · root-level replace {active: …}    (most common — deactivation)
 *       · path-based replace active          (alternate Okta form)
 *       · path-based replace name.givenName  (profile update)
 *       · path-based replace name.familyName (profile update)
 *       · path-based replace name.formatted  (profile update)
 *       · path-based replace title           (enterprise field)
 *       · path-based replace emails[…].value (work email update)
 *     Unknown paths are silent no-ops — NOT throws. A multi-op PATCH
 *     where one op has an unrecognised path must not abort the whole
 *     operation per RFC 7644 §3.5.2 atomicity semantics.
 *
 *   - Soft-delete: PATCH ops that set active=false translate to
 *     {enabled: false}. No delete path exists in the mapping layer —
 *     the store handles the lifecycle_policy branch.
 *     (okta-dialect.md §3, ticket lifecycle_policy=soft_delete)
 */

import type { ScimUser, StoredUser, ScimEmail } from "../../skeleton/types.js";
import type { ScimPatchOperation } from "scim-patch";
import type {
  AcmeHrSystemUser,
  AcmeHrSystemUserCreate,
  AcmeHrSystemUserPatch,
} from "./types.js";

// Schema URNs
export const ENTERPRISE_SCHEMA =
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const CORE_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

// ---------------------------------------------------------------------------
// SCIM → Acme HR System (CREATE path)
// ---------------------------------------------------------------------------

/**
 * Translate an incoming SCIM User POST body into the native create payload.
 * Throws on missing required fields so the SCIM layer can return 400 before
 * hitting the target API.
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
  // sn is nullable for single-token names (Madonna case).
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
    // Default active=true per RFC 7643 §4.1.1 — active is optional in SCIM;
    // absence means active. okta-dialect.md §4.
    enabled: scim.active ?? true,
    memberOf: [],
  };
}

/** Pick the primary email from a SCIM emails array, falling back to the first. */
function pickPrimaryEmail(emails: ScimEmail[] | undefined): string | null {
  if (!emails || emails.length === 0) return null;
  const primary = emails.find((e) => e.primary === true);
  return (primary ?? emails[0])!.value;
}

/**
 * Compose a Common Name from given + family. Handles the Madonna case:
 * if sn is null, cn is just the given name (no trailing space).
 */
function composeCn(given: string, sn: string | null): string {
  if (!sn) return given.trim();
  return `${given} ${sn}`.trim();
}

interface EnterpriseFields {
  employeeNumber: string | null;
  department: string | null;
  title: string | null;
}

/** Extract enterprise extension fields from a SCIM user body, safely. */
function extractEnterprise(
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

// ---------------------------------------------------------------------------
// Acme HR System → SCIM (READ path)
// ---------------------------------------------------------------------------

/**
 * Translate a native Acme HR System user into a SCIM StoredUser.
 * Called by store.get(), store.list(), store.create(), store.patch().
 *
 * okta-dialect.md §11.5: `externalId` contains the SCIM server's unique
 * identifier stored in Okta. We do not set it here — it is Okta's field
 * to round-trip, not ours to assign. The SCIM id field (uid) is what
 * Okta uses for subsequent GET/PATCH/DELETE calls.
 */
export function acmeHrSystemToScim(native: AcmeHrSystemUser): StoredUser {
  const schemas: string[] = [CORE_USER_SCHEMA];

  // Enterprise extension: include iff at least one field is non-null.
  // docs/patterns/ldap.md §2 (enterprise extension conditional).
  const hasEnterprise =
    native.employeeNumber !== null ||
    native.department !== null ||
    native.title !== null;
  if (hasEnterprise) schemas.push(ENTERPRISE_SCHEMA);

  // Name sub-object — omit familyName entirely when sn is null.
  // Okta dialect §11.1 + docs/patterns/ldap.md §4 (Madonna case).
  const name: NonNullable<ScimUser["name"]> = {};
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
      // lastModified approximates created — no separate createdAt in the API.
      // okta-dialect.md §11.6 [OPEN] timestamp format: strip millis, emit Z.
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

/**
 * Strip fractional seconds from an ISO-8601 string and normalise to UTC Z.
 * Conservative default per okta-dialect.md §11.6 [OPEN].
 * "2026-05-05T14:22:00.000Z" → "2026-05-05T14:22:00Z"
 */
function stripMillis(ts: string): string {
  return ts.replace(/\.\d+Z$/, "Z");
}

// ---------------------------------------------------------------------------
// SCIM PATCH → Acme HR System PATCH (UPDATE path)
// ---------------------------------------------------------------------------

/**
 * Translate a SCIM PatchOp Operations array into a native partial-update
 * payload.
 *
 * Handles the four PATCH shapes Okta emits (okta-dialect.md §1):
 *   1. replace unscoped  — `{op:"replace", value:{active:false}}`
 *   2. replace with path — `{op:"replace", path:"active", value:false}`
 *   3. add multi-valued  — not translated here (no add-email flow in scope)
 *   4. remove with filter path — not translated (no field-remove flow)
 *
 * Multi-op PATCH is handled by iterating all ops; unknown paths are
 * silent no-ops, NOT throws (RFC 7644 §3.5.2 atomicity — one unknown
 * path must not abort other ops). okta-dialect.md §1 anti-patterns.
 *
 * Lifecycle_policy=soft_delete: active=false → enabled=false.
 * No delete semantics leak into the mapping layer.
 * okta-dialect.md §3.
 */
export function scimPatchToAcmeHrSystemPatch(
  ops: readonly ScimPatchOperation[],
): AcmeHrSystemUserPatch {
  const patch: AcmeHrSystemUserPatch = {};

  for (const op of ops) {
    // Normalise case: RFC 7644 §3.5.2 says op values are case-insensitive.
    const opLower = op.op.toLowerCase();

    if (opLower === "replace") {
      if (!op.path) {
        // Shape 1: root-level replace — value is an attribute object.
        applyRootValueObject(op.value, patch);
      } else {
        // Shape 2: path-scoped replace.
        applyPathValue(op.path, op.value, patch);
      }
      continue;
    }

    if (opLower === "add") {
      // Shape 3: add to multi-valued attribute. Currently only emails
      // is a candidate; treat as a replace of the primary email value.
      if (op.path) {
        applyPathValue(op.path, op.value, patch);
      } else if (op.value) {
        applyRootValueObject(op.value, patch);
      }
      continue;
    }

    // "remove" ops (Shape 4) are intentionally not translated into a
    // native patch — the Acme HR System has no concept of removing an
    // individual field value without replacing it. Remove ops arriving
    // in practice are for group membership (handled in group store,
    // future scope). Silent no-op here.
  }

  return patch;
}

/** Shape 1 handler: root-level `{op:"replace", value:{...attrs}}`. */
function applyRootValueObject(
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;

  // active → enabled  (okta-dialect.md §3 + §4)
  if (typeof v["active"] === "boolean") patch.enabled = v["active"];

  // name sub-object inside a root-value replace.
  if (typeof v["name"] === "object" && v["name"] !== null) {
    const n = v["name"] as Record<string, unknown>;
    if (typeof n["givenName"] === "string") patch.givenName = n["givenName"];
    if (typeof n["familyName"] === "string") patch.sn = n["familyName"];
    if (typeof n["formatted"] === "string") patch.cn = n["formatted"];
  }

  // displayName → cn (Okta sometimes sends this instead of name.formatted).
  if (typeof v["displayName"] === "string") patch.cn = v["displayName"];

  // emails array — pick the primary or first.
  if (Array.isArray(v["emails"])) {
    const mail = pickPrimaryEmail(v["emails"] as ScimEmail[]);
    if (mail) patch.mail = mail;
  }
}

/** Shape 2 handler: path-scoped replace/add. */
function applyPathValue(
  path: string,
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  // Lowercase the path for case-insensitive matching. RFC 7644 §3.4.2.2
  // attribute names are case-insensitive. okta-dialect.md §2.
  const p = path.toLowerCase().trim();

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

    default: {
      // Complex filter-paths: `emails[type eq "work"].value` and similar.
      // okta-dialect.md §1 — Okta emits this shape for updating a specific
      // multi-valued element. We extract the scalar value if present.
      if (p.startsWith("emails[") && p.endsWith("].value")) {
        if (typeof value === "string") patch.mail = value;
        return;
      }

      // Enterprise extension paths — strip the URN prefix if present.
      const enterprisePrefix =
        "urn:ietf:params:scim:schemas:extension:enterprise:2.0:user:";
      if (p.startsWith(enterprisePrefix)) {
        const subPath = p.slice(enterprisePrefix.length);
        applyEnterpriseSubPath(subPath, value, patch);
        return;
      }

      // Unknown path — silent no-op per RFC 7644 §3.5.2 rationale above.
      return;
    }
  }
}

/** Apply an enterprise-extension sub-path (after the URN prefix is stripped). */
function applyEnterpriseSubPath(
  subPath: string,
  value: unknown,
  patch: AcmeHrSystemUserPatch,
): void {
  switch (subPath) {
    case "employeenumber":
      if (typeof value === "string") patch.employeeNumber = value;
      return;
    case "department":
      if (typeof value === "string") patch.department = value;
      return;
    case "title":
      if (typeof value === "string") patch.title = value;
      return;
    default:
      // Unknown enterprise sub-path — silent no-op.
      return;
  }
}