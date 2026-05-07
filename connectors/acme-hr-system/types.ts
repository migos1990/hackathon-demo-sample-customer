/**
 * Acme HR System — LDAP-shaped user model (OKT-10).
 *
 * The customer's native API returns an LDAP-flavored shape. The SCIM
 * connector translates between SCIM 2.0 (what Okta speaks) and this
 * representation. See docs/patterns/ldap.md for the full pattern rationale.
 *
 * Source of truth for these field names: ticket OKT-10 + customer API docs
 * shared in the ticket. Update this file if the customer's API shape drifts.
 */

export interface AcmeHrSystemUser {
  /** Primary key — LDAP uid. Immutable. SCIM `id` and `userName` map here. */
  uid: string;
  /** Common Name — "Given Family". SCIM `name.formatted` maps here. */
  cn: string;
  /** First name. SCIM `name.givenName`. */
  givenName: string;
  /**
   * Last name. SCIM `name.familyName`. May be null for single-token names
   * (the "Madonna case" documented in docs/patterns/ldap.md §4).
   */
  sn: string | null;
  /** Primary email. SCIM `emails[primary=true].value`. */
  mail: string;
  /** Employment ID. SCIM enterprise extension `employeeNumber`. Nullable. */
  employeeNumber: string | null;
  /** Job title. SCIM enterprise `title`. Nullable. */
  title: string | null;
  /** Department. SCIM enterprise `department`. Nullable. */
  department: string | null;
  /**
   * Active flag — the lifecycle signal.
   *
   * Lifecycle policy for OKT-10 is SOFT-DELETE (per ticket). The connector
   * translates Okta's `PATCH active:false` (deprovisioning) into a PATCH
   * that sets this field to false. Rows are NEVER deleted — the customer
   * has a 7-year compliance audit requirement.
   *
   * See okta-dialect.md §3 (Soft vs hard delete) and §4 (`active` behavior).
   */
  enabled: boolean;
  /**
   * Group DNs — e.g. "cn=engineers,ou=groups,dc=acme-hr,dc=example,dc=com".
   * Groups are read-only from the SCIM connector's perspective for OKT-10
   * (required_ops has no group push). Preserved on round-trips; not mutated
   * by any SCIM operation this connector handles.
   */
  memberOf: string[];
  /** ISO-8601 timestamp; server stamps on every write. */
  lastModified: string;
}

/**
 * Input for POST /users. `lastModified` is server-stamped on insert.
 */
export type AcmeHrSystemUserCreate = Omit<AcmeHrSystemUser, "lastModified">;

/**
 * PATCH input — any mutable subset. `uid` is immutable (renaming would
 * break Okta's externalId correlation — see okta-dialect.md §11.5).
 * `lastModified` is server-stamped on every mutation.
 */
export type AcmeHrSystemUserPatch = Partial<
  Omit<AcmeHrSystemUser, "uid" | "lastModified">
>;