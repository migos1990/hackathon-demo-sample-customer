/**
 * AcmeCorpQ3 — native LDAP-shaped user model.
 *
 * The customer's HR system exposes an LDAP-flavored REST API. Field
 * names mirror the pattern documented in docs/patterns/ldap.md §1.
 *
 * This is NOT a SCIM schema — it's the customer's wire format. The
 * mapping layer in mapping.ts translates between this and SCIM 2.0.
 *
 * Ticket: OKT-57 | customer_slug: acme-corp-q3 | user_model_source: ldap
 */

export interface AcmeCorpQ3User {
  /** Primary key — LDAP uid; used as SCIM id + userName per ldap pattern §1. */
  uid: string;
  /** Common Name — "GivenName Surname"; maps to SCIM name.formatted. */
  cn: string;
  /** First name — maps to SCIM name.givenName. */
  givenName: string;
  /**
   * Last name — maps to SCIM name.familyName.
   * Nullable: single-token names (e.g. "Madonna") have sn=null.
   * See docs/patterns/ldap.md §4 (Madonna case).
   */
  sn: string | null;
  /** Primary email — maps to SCIM emails[primary=true].value. */
  mail: string;
  /** Employment ID — maps to SCIM enterprise extension employeeNumber. Optional. */
  employeeNumber: string | null;
  /** Job title — maps to SCIM enterprise extension title. Optional. */
  title: string | null;
  /** Department — maps to SCIM enterprise extension department. Optional. */
  department: string | null;
  /**
   * Lifecycle flag. lifecycle_policy=soft_delete means we NEVER delete rows;
   * we only flip this to false. See docs/okta-dialect.md §3 and §4.
   * Deactivation flow: Okta sends PATCH active=false → connector patches
   * enabled=false on the customer's API.
   */
  enabled: boolean;
  /** Group DNs. Read-only here; groups ops not required per OKT-57. */
  memberOf: string[];
  /** ISO-8601 server timestamp, written on every mutation. */
  lastModified: string;
}

/**
 * POST /users input — server-managed fields omitted.
 * The target API stamps lastModified on insert.
 */
export type AcmeCorpQ3UserCreate = Omit<AcmeCorpQ3User, "lastModified">;

/**
 * PATCH /users/{uid} input — any mutable subset.
 * uid is immutable (primary key); lastModified is server-managed.
 */
export type AcmeCorpQ3UserPatch = Partial<
  Omit<AcmeCorpQ3User, "uid" | "lastModified">
>;