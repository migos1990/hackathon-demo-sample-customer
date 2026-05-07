/**
 * Acme HR System — native LDAP-shaped user model.
 *
 * This is the target-app's wire format, NOT a SCIM schema. The SCIM
 * connector translates between SCIM 2.0 (what Okta speaks) and this
 * shape (what the Acme HR System REST API exposes).
 *
 * Field choices follow the LDAP pattern documented in
 * docs/patterns/ldap.md §1 (source-schema shape).
 */

export interface AcmeHrSystemUser {
  /** Primary key — LDAP uid; maps to SCIM `id` and `userName`. Immutable. */
  uid: string;
  /** Common Name — "Given Family"; maps to SCIM `name.formatted`. */
  cn: string;
  /** First name — maps to SCIM `name.givenName`. */
  givenName: string;
  /**
   * Last name — maps to SCIM `name.familyName`.
   * Null for single-token names (Madonna case — see mapping.ts).
   */
  sn: string | null;
  /** Primary email — maps to SCIM `emails[primary=true].value`. */
  mail: string;
  /** Employment ID — maps to SCIM enterprise extension `employeeNumber`. */
  employeeNumber: string | null;
  /** Job title — maps to SCIM enterprise extension `title`. */
  title: string | null;
  /** Department — maps to SCIM enterprise extension `department`. */
  department: string | null;
  /**
   * Lifecycle flag — THE deprovisioning signal.
   *
   * Lifecycle policy for this connector is `soft_delete` per OKT-10:
   * rows are NEVER deleted. Deactivation (Okta PATCH active=false) and
   * DELETE /Users/:id both resolve to setting this field false.
   * See okta-dialect.md §3 (soft_delete policy) and §4 (active attribute).
   */
  enabled: boolean;
  /** Group DNs — not consumed by the current connector (groups not in scope for OKT-10). */
  memberOf: string[];
  /** ISO-8601 timestamp; the target stamps this on every mutation. */
  lastModified: string;
}

/**
 * Create payload — same as AcmeHrSystemUser minus server-managed fields.
 * `lastModified` is stamped by the target on insert.
 */
export type AcmeHrSystemUserCreate = Omit<AcmeHrSystemUser, "lastModified">;

/**
 * PATCH payload — any mutable subset. `uid` is immutable (renaming would
 * break provisioning identity across Okta + target). `lastModified` is
 * server-stamped on every write.
 */
export type AcmeHrSystemUserPatch = Partial<
  Omit<AcmeHrSystemUser, "uid" | "lastModified">
>;