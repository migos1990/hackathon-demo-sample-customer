/**
 * Acme HR System — LDAP-shaped user model.
 *
 * This is the customer's native API shape, NOT a SCIM schema. The connector
 * translates between SCIM 2.0 (Okta-facing) and this shape (target-facing).
 * Shape mirrors the LDAP pattern documented in docs/patterns/ldap.md.
 *
 * ticket: OKT-10
 * customer: Acme HR System
 * slug: acme-hr-system
 */

export interface AcmeHrSystemUser {
  /** Primary key — LDAP uid; maps to SCIM `userName` and SCIM `id`. */
  uid: string;
  /** Common Name ("Given Family"); maps to SCIM `name.formatted`. */
  cn: string;
  /** First name; maps to SCIM `name.givenName`. */
  givenName: string;
  /**
   * Last name; maps to SCIM `name.familyName`.
   * Nullable for single-token names (the "Madonna case" per docs/patterns/ldap.md §4).
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
   * Active flag — the lifecycle signal. Soft-delete policy (OKT-10) means
   * we NEVER delete a row; deactivation sets this to false.
   * Per okta-dialect.md §3: Okta's deprovisioning signal is PATCH active:false,
   * NOT DELETE. The DELETE handler on the SCIM layer also maps here.
   */
  enabled: boolean;
  /** Group DNs; maps to SCIM `groups[].display`. */
  memberOf: string[];
  /** ISO-8601 timestamp; server-stamped on every mutation. */
  lastModified: string;
}

/**
 * POST /users input — server-managed fields omitted.
 * `lastModified` is stamped by the target on insert.
 */
export type AcmeHrSystemUserCreate = Omit<AcmeHrSystemUser, "lastModified">;

/**
 * PATCH /users/:uid input — any subset of mutable fields.
 * `uid` is immutable (renaming breaks provisioning identity).
 */
export type AcmeHrSystemUserPatch = Partial<
  Omit<AcmeHrSystemUser, "uid" | "lastModified">
>;