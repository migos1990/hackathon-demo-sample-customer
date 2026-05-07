/**
 * Acme HR System — LDAP-shaped native user model.
 *
 * This is NOT a SCIM schema. The SCIM connector translates between the
 * SCIM 2.0 wire format (what Okta speaks) and this LDAP-flavored shape
 * (what the Acme HR System API exposes).
 *
 * Field choices mirror the LDAP source pattern documented in
 * docs/patterns/ldap.md §1 (source-schema shape).
 *
 * Ticket: OKT-10
 */

export interface AcmeHrSystemUser {
  /** Primary key — LDAP uid; maps to SCIM `id` and `userName`. Immutable. */
  uid: string;
  /** Common Name ("Given Family"); maps to SCIM `name.formatted`. */
  cn: string;
  /** First name; maps to SCIM `name.givenName`. */
  givenName: string;
  /**
   * Last name; maps to SCIM `name.familyName`.
   * May be null for single-token names (Madonna case — see mapping.ts).
   */
  sn: string | null;
  /** Primary email; maps to SCIM `emails[primary=true].value`. */
  mail: string;
  /** Employment ID; maps to SCIM enterprise extension `employeeNumber`. */
  employeeNumber: string | null;
  /** Job title; maps to SCIM enterprise extension `title`. */
  title: string | null;
  /** Department; maps to SCIM enterprise extension `department`. */
  department: string | null;
  /**
   * Lifecycle flag. Okta's deprovisioning signal (PATCH active:false) maps
   * here. Per lifecycle_policy=soft_delete the connector never deletes the
   * row — it only flips this flag.
   *
   * Per okta-dialect.md §3: Okta sends PATCH active:false, NOT DELETE, for
   * standard deprovisioning. The DELETE handler on /Users also soft-deletes
   * when lifecycle_policy is soft_delete.
   */
  enabled: boolean;
  /** Group DNs — populated by the source directory. Read-only for this connector. */
  memberOf: string[];
  /** ISO-8601 timestamp; source stamps on every mutation. */
  lastModified: string;
}

/**
 * Input shape for POST /users — same as AcmeHrSystemUser minus
 * server-managed fields. `lastModified` is stamped by the target on insert.
 */
export type AcmeHrSystemUserCreate = Omit<AcmeHrSystemUser, "lastModified">;

/**
 * PATCH input — any mutable subset. `uid` is immutable; excluded on purpose
 * (renaming breaks provisioning identity correlation in Okta).
 */
export type AcmeHrSystemUserPatch = Partial<
  Omit<AcmeHrSystemUser, "uid" | "lastModified">
>;