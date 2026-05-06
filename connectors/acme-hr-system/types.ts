/**
 * Acme HR System — LDAP-shaped user model.
 *
 * This is NOT a SCIM schema. It describes the native shape of
 * the customer's API at https://api.acme-hr.example.com.
 *
 * Field mapping overview (SCIM ↔ Acme HR System):
 *   SCIM `id` / `userName`         ← `uid`           (primary key, immutable)
 *   SCIM `name.formatted`          ← `cn`
 *   SCIM `name.givenName`          ← `givenName`
 *   SCIM `name.familyName`         ← `sn`            (nullable — single-token names)
 *   SCIM `emails[primary].value`   ← `mail`
 *   SCIM enterprise `employeeNumber` ← `employeeNumber`
 *   SCIM enterprise `department`   ← `department`
 *   SCIM `title`                   ← `title`
 *   SCIM `active`                  ← `enabled`       (lifecycle flag — soft-delete only)
 *   SCIM `groups[].display`        ← `memberOf[]`    (DN strings)
 *   SCIM `meta.lastModified`       ← `lastModified`
 *
 * Lifecycle policy: SOFT DELETE (okta-dialect.md §3).
 * User rows are NEVER removed from Acme HR System. Deactivation sets
 * `enabled: false`. The `DELETE /Users/:id` SCIM endpoint also maps to
 * `enabled: false` (not a hard delete) per the ticket's lifecycle_policy.
 */

export interface AcmeHrSystemUser {
  /** Primary key — immutable. SCIM `userName` and `id` both map here. */
  uid: string;
  /** Common Name — "Given Family". SCIM `name.formatted`. */
  cn: string;
  /** First name. SCIM `name.givenName`. */
  givenName: string;
  /**
   * Last name. SCIM `name.familyName`. Nullable for single-token names
   * (the "Madonna case" — pattern-1 §4 edge case table).
   */
  sn: string | null;
  /** Primary email. SCIM `emails[primary=true].value`. Required. */
  mail: string;
  /** HR employment ID. SCIM enterprise extension `employeeNumber`. */
  employeeNumber: string | null;
  /** Job title. SCIM enterprise `title`. */
  title: string | null;
  /** Department. SCIM enterprise `department`. */
  department: string | null;
  /**
   * Lifecycle flag. Set to false on deactivation (soft-delete policy).
   * Never removed — rows are retained for audit/compliance.
   * Maps bidirectionally to SCIM `active`.
   */
  enabled: boolean;
  /** Group DNs. Empty array when user belongs to no groups. */
  memberOf: string[];
  /** ISO-8601 timestamp written by the server on every mutation. */
  lastModified: string;
}

/**
 * Body for POST /users — server stamps `lastModified`.
 */
export type AcmeHrSystemUserCreate = Omit<AcmeHrSystemUser, "lastModified">;

/**
 * Body for PATCH /users/:uid — any mutable subset.
 * `uid` is intentionally omitted: renaming the primary key would break
 * Okta's provisioning identity correlation (okta-dialect.md §11.5).
 */
export type AcmeHrSystemUserPatch = Partial<
  Omit<AcmeHrSystemUser, "uid" | "lastModified">
>;