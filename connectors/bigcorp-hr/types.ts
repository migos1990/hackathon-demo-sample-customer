/**
 * BigCorpHR native user model — LDAP-shaped, mirroring the source schema
 * described in docs/attribute-mapping-patterns.md §1 (Pattern 1 — LDAP).
 *
 * This is NOT a SCIM schema.  The connector's mapping.ts translates
 * between this shape and the SCIM 2.0 wire format Okta consumes.
 *
 * lifecycle_policy: soft_delete — `enabled` is the lifecycle flag.
 * BigCorpHR user rows are never removed; deactivation sets enabled=false.
 * okta-dialect.md §3 "Soft vs hard delete".
 */

export interface BigCorpHrUser {
  /** Primary key.  Immutable.  SCIM `id` and `userName` both map here. */
  uid: string;
  /** Common Name — "Given Family".  SCIM `name.formatted`. */
  cn: string;
  /** First name.  SCIM `name.givenName`. */
  givenName: string;
  /**
   * Last name.  SCIM `name.familyName`.
   * Null for single-token names (Madonna case) — mapping omits
   * `familyName` rather than emitting null.
   */
  sn: string | null;
  /** Primary email.  SCIM `emails[primary=true].value`. */
  mail: string;
  /** Employment ID.  SCIM enterprise extension `employeeNumber`. */
  employeeNumber: string | null;
  /** Job title.  SCIM `title` / enterprise `title`. */
  title: string | null;
  /** Org unit.  SCIM enterprise `department`. */
  department: string | null;
  /**
   * Lifecycle flag.  Deactivation sets this false; the row is retained.
   * okta-dialect.md §3 (soft_delete policy) + §4 (active attribute).
   */
  enabled: boolean;
  /** Group DNs.  Not used in this connector (groups: false in ticket). */
  memberOf: string[];
  /** ISO-8601 timestamp written by BigCorpHR on every mutation. */
  lastModified: string;
}

/**
 * Input shape for POST /users — server-managed fields excluded.
 * `lastModified` is stamped by BigCorpHR on insert.
 */
export type BigCorpHrUserCreate = Omit<BigCorpHrUser, "lastModified">;

/**
 * PATCH input — any subset of mutable fields.
 * `uid` is immutable and intentionally omitted from this type.
 */
export type BigCorpHrUserPatch = Partial<
  Omit<BigCorpHrUser, "uid" | "lastModified">
>;