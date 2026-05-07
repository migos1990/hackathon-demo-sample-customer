/**
 * Acme HR System — LDAP-shaped native user model.
 *
 * This is NOT a SCIM schema. The connector's mapping layer (mapping.ts)
 * translates between SCIM 2.0 (what Okta speaks) and this shape (what
 * Acme HR System exposes via its REST API).
 *
 * Source: ticket OKT-10, customer_app_name "Acme HR System",
 * user_model_source "ldap". Field names mirror the LDAP-pattern spec
 * in docs/patterns/ldap.md §1.
 *
 * Lifecycle policy: "soft_delete" — rows are NEVER removed. Deactivation
 * flips `enabled` to false. See okta-dialect.md §3 (soft delete / deactivate).
 */

export interface AcmeHrSystemUser {
  /** Primary key. Immutable. Doubles as SCIM `id` and `userName`. */
  uid: string;
  /** Common Name — "Given Family". SCIM `name.formatted`. */
  cn: string;
  /** First name. SCIM `name.givenName`. */
  givenName: string;
  /**
   * Last name. SCIM `name.familyName`.
   * Nullable for single-token names (Madonna case — docs/patterns/ldap.md §4).
   */
  sn: string | null;
  /** Primary email. SCIM `emails[primary=true].value`. */
  mail: string;
  /** Employment ID. SCIM enterprise extension `employeeNumber`. Nullable. */
  employeeNumber: string | null;
  /** Job title. SCIM `title`. Nullable. */
  title: string | null;
  /** Department. SCIM enterprise `department`. Nullable. */
  department: string | null;
  /**
   * Active/lifecycle flag. Deactivation sets this to false; the row is
   * retained indefinitely (soft_delete policy — OKT-10 lifecycle_policy).
   * See okta-dialect.md §3 and §4.
   */
  enabled: boolean;
  /**
   * Group DNs this user is a member of. Not currently synced to SCIM
   * (required_ops.groups is absent from OKT-10 ticket); preserved in
   * round-trips so the target doesn't lose membership data.
   */
  memberOf: string[];
  /** ISO-8601 timestamp; server-stamped on every mutation. */
  lastModified: string;
}

/**
 * Create input — all fields except server-managed `lastModified`.
 */
export type AcmeHrSystemUserCreate = Omit<AcmeHrSystemUser, "lastModified">;

/**
 * PATCH input — any subset of mutable fields.
 * `uid` is immutable and intentionally excluded — renaming would break
 * Okta's provisioning identity correlation (okta-dialect.md §11.5).
 */
export type AcmeHrSystemUserPatch = Partial<
  Omit<AcmeHrSystemUser, "uid" | "lastModified">
>;