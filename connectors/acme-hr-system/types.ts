/**
 * Native user model for Acme HR System — LDAP-shaped REST API.
 *
 * This is NOT a SCIM schema. The connector translates between SCIM 2.0
 * (what Okta speaks) and this shape (what Acme HR System exposes).
 * Attribute mapping lives in mapping.ts.
 *
 * Mirrors the LDAP source pattern documented in
 * docs/patterns/ldap.md §1 "Source-schema shape".
 *
 * Ticket: OKT-10
 */

export interface AcmeHrSystemUser {
  /** Primary key — LDAP `uid`; SCIM `userName` maps here. Immutable. */
  uid: string;
  /** Common Name — "Given Family"; SCIM `name.formatted`. */
  cn: string;
  /** First name — SCIM `name.givenName`. */
  givenName: string;
  /**
   * Last name — SCIM `name.familyName`.
   * Null for single-token names (Madonna case) — connector omits
   * `name.familyName` rather than emitting null per pattern §4 edge cases.
   */
  sn: string | null;
  /** Primary email — SCIM `emails[primary=true].value`. Required. */
  mail: string;
  /** Employment ID — SCIM enterprise extension `employeeNumber`. Optional. */
  employeeNumber: string | null;
  /** Job title — SCIM enterprise extension `title`. Optional. */
  title: string | null;
  /** Department — SCIM enterprise extension `department`. Optional. */
  department: string | null;
  /**
   * Lifecycle flag.
   *
   * lifecycle_policy=soft_delete: rows are NEVER deleted from Acme HR System.
   * Deactivation (Okta SCIM `active: false`) maps to `{enabled: false}`.
   * Reactivation maps to `{enabled: true}`.
   * DELETE /scim/v2/Users/{id} also maps to `{enabled: false}` per
   * okta-dialect.md §3 — Okta drives lifecycle through PATCH active:false,
   * not HTTP DELETE; we honour DELETE by soft-deleting.
   */
  enabled: boolean;
  /** Group DNs — SCIM `groups[].display`. */
  memberOf: string[];
  /**
   * ISO-8601 timestamp stamped by Acme HR System on every mutation.
   * Used as both `meta.lastModified` and (approximated as) `meta.created`
   * since the API exposes no separate creation timestamp.
   * See okta-dialect.md §11.6 — emit without fractional seconds.
   */
  lastModified: string;
}

/**
 * Input shape for POST /users — server-managed fields excluded.
 * `lastModified` is stamped by Acme HR System on insert.
 */
export type AcmeHrSystemUserCreate = Omit<AcmeHrSystemUser, "lastModified">;

/**
 * PATCH input — any subset of mutable fields.
 * `uid` is immutable (renaming would break Okta's externalId correlation,
 * per okta-dialect.md §11.5). Excluded deliberately.
 */
export type AcmeHrSystemUserPatch = Partial<
  Omit<AcmeHrSystemUser, "uid" | "lastModified">
>;