/**
 * Native user model for "Acme HR System" — LDAP-shaped REST API.
 *
 * Source pattern: Pattern 1 (LDAP-shaped source) per
 *   docs/attribute-mapping-patterns.md#pattern-1-ldap-shaped-source
 *
 * This is NOT a SCIM schema. The connector's mapping layer translates
 * between this shape and the SCIM 2.0 User resource Okta expects.
 *
 * Field choices match the canonical LDAP-to-REST shape described in
 * ticket-templates/new-scim-connector.md and the AcmeHR-lite reference
 * connector at connectors/acme-hr/mapping.ts.
 *
 * Lifecycle policy (OKT-10): soft_delete — users are NEVER deleted from
 * the target system. Deactivation sets `enabled: false` on both the
 * PATCH active:false path and the DELETE path. See RUNBOOK.md §Lifecycle.
 */

export interface AcmeHrSystemUser {
  /** Primary key — LDAP `uid`. Immutable. Maps to SCIM `id` and `userName`. */
  uid: string;

  /**
   * Common Name — "Given Family" format. Maps to SCIM `name.formatted`.
   * May be the only name field present for single-token users (Madonna case).
   */
  cn: string;

  /** Given name. Maps to SCIM `name.givenName`. */
  givenName: string;

  /**
   * Surname. Maps to SCIM `name.familyName`.
   * Null for single-token names — the mapping layer omits `familyName` from
   * the SCIM payload entirely rather than emitting null
   * (okta-dialect.md §2 + Pattern 1 §4 "Madonna case").
   */
  sn: string | null;

  /** Primary email. Maps to SCIM `emails[{primary:true,type:"work"}]`. */
  mail: string;

  /** HR employment identifier. Maps to enterprise extension `employeeNumber`. */
  employeeNumber: string | null;

  /** Job title. Maps to SCIM enterprise extension `title`. */
  title: string | null;

  /** Department. Maps to SCIM enterprise extension `department`. */
  department: string | null;

  /**
   * Lifecycle flag. THE canonical lifecycle signal for this connector.
   * SCIM `active: false` → `enabled: false`. SCIM `active: true` → `enabled: true`.
   * Rows are retained forever for compliance audit (lifecycle_policy: soft_delete
   * per OKT-10 — okta-dialect.md §3 "Soft delete / deactivate (default)").
   */
  enabled: boolean;

  /** Group DNs the user belongs to. Empty array when user is in no groups. */
  memberOf: string[];

  /**
   * Server-stamped ISO-8601 timestamp on every mutation.
   * Mapped to both `meta.lastModified` and `meta.created` (Acme HR System
   * does not expose a separate creation timestamp — see mapping.ts comment).
   */
  lastModified: string;
}

/**
 * POST /users input — all fields except server-managed `lastModified`.
 */
export type AcmeHrSystemUserCreate = Omit<AcmeHrSystemUser, "lastModified">;

/**
 * PATCH /users/:uid input — any subset of mutable fields.
 * `uid` is immutable and must not appear in patch bodies.
 */
export type AcmeHrSystemUserPatch = Partial<
  Omit<AcmeHrSystemUser, "uid" | "lastModified">
>;