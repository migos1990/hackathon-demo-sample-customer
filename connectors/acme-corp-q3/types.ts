/**
 * Native types for the Acme Corp Q3 Internal HR System API.
 *
 * This is NOT a SCIM schema. The connector's mapping layer (mapping.ts)
 * translates between SCIM 2.0 (what Okta speaks) and this LDAP-flavored
 * shape (what the HR API exposes).
 *
 * Shape mirrors the LDAP pattern documented in
 * docs/patterns/ldap.md §1 (Source-schema shape). Fields chosen to match
 * the customer's native API as described in ticket OKT-54.
 *
 * Lifecycle policy: soft_delete per ticket OKT-54.
 * Okta sends PATCH active:false on deprovision; this connector translates
 * that to {enabled: false} on the target. Rows are NEVER hard-deleted.
 * See okta-dialect.md §3 (Soft vs hard delete) and §4 (active attribute).
 */

export interface AcmeCorpQ3User {
  /** Primary key. Immutable. Maps to SCIM `id` and `userName`. */
  uid: string;
  /** Common Name — "Given Family". Maps to SCIM `name.formatted`. */
  cn: string;
  /** First name. Maps to SCIM `name.givenName`. */
  givenName: string;
  /**
   * Surname. May be null for single-token names (e.g. "Madonna").
   * Connector omits SCIM `name.familyName` entirely when null rather than
   * emitting null — Okta consumers may reject null family names.
   * See docs/patterns/ldap.md §4 (Single-token name handling).
   */
  sn: string | null;
  /** Primary email. Maps to SCIM `emails[primary=true].value`. */
  mail: string;
  /** Employment ID. Maps to SCIM enterprise extension `employeeNumber`. */
  employeeNumber: string | null;
  /** Job title. Maps to SCIM enterprise extension `title`. */
  title: string | null;
  /** Department. Maps to SCIM enterprise extension `department`. */
  department: string | null;
  /**
   * Lifecycle flag. THE deprovisioning signal per okta-dialect.md §3.
   * Okta sends PATCH active:false → connector writes {enabled: false}.
   * Rows are never deleted (soft_delete policy, ticket OKT-54).
   */
  enabled: boolean;
  /** Group DNs. Unused by this connector (groups not required in OKT-54). */
  memberOf: string[];
  /** ISO-8601 timestamp. HR system writes on every mutation. */
  lastModified: string;
}

/**
 * Input shape for POST /users — same as AcmeCorpQ3User minus the
 * server-managed `lastModified` field.
 */
export type AcmeCorpQ3UserCreate = Omit<AcmeCorpQ3User, "lastModified">;

/**
 * PATCH input — any mutable subset. `uid` is immutable and deliberately
 * absent from this type (renaming would break Okta's provisioning identity
 * correlation via externalId — see okta-dialect.md §11.5).
 */
export type AcmeCorpQ3UserPatch = Partial<
  Omit<AcmeCorpQ3User, "uid" | "lastModified">
>;