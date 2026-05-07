/**
 * Acme HR System — LDAP-shaped user model.
 *
 * The native API returns LDAP-flavoured objects. The connector translates
 * these to/from SCIM 2.0 in mapping.ts. Fields mirror the reference
 * pattern at connectors/acme-hr/ and ticket OKT-10 (user_model_source: ldap).
 *
 * Nothing in this file is SCIM — it describes what the customer's API
 * actually sends and receives.
 */

export interface AcmeHrSystemUser {
  /** Primary key — immutable. SCIM `id` and `userName` both map here. */
  uid: string;
  /** Common Name — "Given Family". SCIM `name.formatted`. */
  cn: string;
  /** First name. SCIM `name.givenName`. */
  givenName: string;
  /**
   * Surname. May be null for single-token names (Madonna case).
   * SCIM `name.familyName` is omitted entirely when null rather than
   * emitting null — some Okta consumers reject null family names.
   * Tested in mapping.test.ts single-token cases.
   */
  sn: string | null;
  /** Primary email. SCIM `emails[primary=true].value`. */
  mail: string;
  /** Employment ID. SCIM enterprise extension `employeeNumber`. */
  employeeNumber: string | null;
  /** Job title. SCIM enterprise extension `title`. */
  title: string | null;
  /** Department. SCIM enterprise extension `department`. */
  department: string | null;
  /**
   * Lifecycle flag. The connector implements soft_delete (ticket OKT-10
   * lifecycle_policy: soft_delete) — rows are never removed; deactivation
   * sets this to false.
   *
   * Per okta-dialect.md §3: Okta's deprovisioning signal is
   * PATCH active: false, NOT DELETE. Both the SCIM PATCH handler and the
   * SCIM DELETE handler converge on enabled: false for soft_delete policy.
   */
  enabled: boolean;
  /** Group DNs. Informational — group push not in scope for OKT-10. */
  memberOf: string[];
  /** ISO-8601 server-stamped on every mutation. SCIM meta.lastModified. */
  lastModified: string;
}

/**
 * Input for POST /users — server stamps lastModified on insert.
 */
export type AcmeHrSystemUserCreate = Omit<AcmeHrSystemUser, "lastModified">;

/**
 * PATCH input — any subset of mutable fields.
 * `uid` is immutable and intentionally excluded: renaming the primary key
 * would break Okta's externalId cross-reference (okta-dialect.md §11.5).
 */
export type AcmeHrSystemUserPatch = Partial<
  Omit<AcmeHrSystemUser, "uid" | "lastModified">
>;