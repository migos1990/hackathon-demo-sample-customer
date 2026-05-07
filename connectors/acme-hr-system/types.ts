/**
 * Acme HR System — LDAP-shaped native user model.
 *
 * These types describe what the Acme HR API returns on the wire.
 * They are intentionally NOT SCIM types — the connector's mapping.ts
 * is responsible for the translation. See docs/patterns/ldap.md §1
 * for the canonical field-level description of this pattern.
 *
 * Field names mirror the AcmeHR-lite reference target
 * (demo-targets/acme-hr-lite/types.ts) because both systems follow
 * the same LDAP-proxy REST convention. Real captures from
 * api.acme-hr.example.com should be validated against these types
 * before the connector goes to staging.
 */

export interface AcmeHrSystemUser {
  /** Primary key. Immutable. Maps to SCIM `id` AND `userName`. */
  uid: string;
  /** Common Name — "Given Family". Maps to SCIM `name.formatted`. */
  cn: string;
  /** First name. Maps to SCIM `name.givenName`. */
  givenName: string;
  /**
   * Last name. Nullable for single-token names ("Madonna case").
   * Maps to SCIM `name.familyName`; omitted from SCIM when null.
   * See docs/patterns/ldap.md §4 (single-token name handling).
   */
  sn: string | null;
  /** Primary email. Maps to SCIM `emails[primary=true].value`. */
  mail: string;
  /**
   * Employment ID. Maps to enterprise extension `employeeNumber`.
   * Omitted from SCIM when null.
   */
  employeeNumber: string | null;
  /** Job title. Maps to SCIM enterprise `title`. Omitted when null. */
  title: string | null;
  /** Department. Maps to SCIM enterprise `department`. Omitted when null. */
  department: string | null;
  /**
   * Lifecycle flag. Okta deactivation → connector PATCHes this to false.
   * Per ticket lifecycle_policy=soft_delete: rows are NEVER deleted,
   * only flipped to enabled=false. See okta-dialect.md §3.
   */
  enabled: boolean;
  /**
   * Group DNs. e.g. "cn=engineers,ou=groups,dc=acme-hr,dc=example,dc=com".
   * Maps to SCIM `groups[].display` on read. Empty array when user has
   * no group memberships.
   */
  memberOf: string[];
  /**
   * ISO-8601 timestamp. Written by the Acme HR System on every mutation.
   * Doubles as SCIM `meta.created` (approximate — the API has no separate
   * createdAt) per docs/patterns/ldap.md §2.
   */
  lastModified: string;
}

/**
 * POST body for creating a user. All fields except server-stamped
 * `lastModified`.
 */
export type AcmeHrSystemUserCreate = Omit<AcmeHrSystemUser, "lastModified">;

/**
 * PATCH body. Any subset of mutable fields.
 * `uid` is immutable and excluded on purpose — renaming breaks
 * Okta's `externalId` correlation (see okta-dialect.md §11.5).
 */
export type AcmeHrSystemUserPatch = Partial<
  Omit<AcmeHrSystemUser, "uid" | "lastModified">
>;