/**
 * acme-corp-q3 — LDAP-shaped user model for the Internal HR System.
 *
 * This is NOT a SCIM schema. The SCIM connector translates between
 * SCIM 2.0 (what Okta speaks) and this LDAP-flavored shape (what the
 * Internal HR System exposes).
 *
 * Source pattern: docs/patterns/ldap.md
 * Field choices mirror the ticket OKT-60 user_model_source: "ldap".
 */

export interface AcmeCorpQ3User {
  /** Primary key — matches `uid` in LDAP; SCIM `userName` maps to this. */
  uid: string;
  /** Common Name — "Given Family"; SCIM `name.formatted` maps here. */
  cn: string;
  /** First name — SCIM `name.givenName`. */
  givenName: string;
  /**
   * Last name — SCIM `name.familyName`. Nullable for single-token names
   * (the "Madonna case" per docs/patterns/ldap.md §4).
   */
  sn: string | null;
  /** Primary email — SCIM `emails[primary=true].value`. */
  mail: string;
  /** Employment ID — SCIM enterprise extension `employeeNumber`. */
  employeeNumber: string | null;
  /** Job title — SCIM enterprise extension `title`. */
  title: string | null;
  /** Department — SCIM enterprise extension `department`. */
  department: string | null;
  /**
   * Active flag — the lifecycle signal. Lifecycle policy for OKT-60 is
   * "soft_delete": deactivation sets this to false; rows are NEVER deleted.
   * Per okta-dialect.md §3: Okta's primary deprovisioning signal is
   * PATCH active=false, NOT DELETE. The DELETE handler also soft-deletes
   * (same policy outcome, different HTTP verb — see store.ts).
   */
  enabled: boolean;
  /** Group DNs — read-only for now; groups not in required_ops for OKT-60. */
  memberOf: string[];
  /** ISO-8601 timestamp; written by the HR system on every mutation. */
  lastModified: string;
}

/**
 * Input shape for POST /users — same as AcmeCorpQ3User minus server-managed
 * fields. `lastModified` is server-stamped on insert.
 */
export type AcmeCorpQ3UserCreate = Omit<AcmeCorpQ3User, "lastModified">;

/**
 * PATCH input — any subset of mutable fields. `uid` is immutable; excluded
 * intentionally (renaming the primary key would break provisioning identity
 * and corrupt Okta's externalId correlation per okta-dialect.md §11.5).
 */
export type AcmeCorpQ3UserPatch = Partial<Omit<AcmeCorpQ3User, "uid" | "lastModified">>;