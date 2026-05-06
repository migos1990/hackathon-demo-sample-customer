/**
 * Acme HR System — LDAP-shaped native user model.
 *
 * This is NOT a SCIM schema. The connector translates between SCIM 2.0
 * (what Okta speaks) and this LDAP-flavored shape (what Acme HR System
 * exposes). See connectors/acme-hr-system/mapping.ts for the transforms.
 *
 * Shape mirrors docs/patterns/ldap.md §1 "Source-schema shape" exactly.
 * The demo-targets/acme-hr-lite/types.ts reference model was used as the
 * basis; this copy is self-contained so this connector has no runtime
 * dependency on the demo target package.
 */

export interface AcmeHrSystemUser {
  /**
   * Primary key — the LDAP `uid` attribute. Immutable. Used as both the
   * SCIM `id` and SCIM `userName` (LDAP-backed SCIM convention per
   * docs/patterns/ldap.md §2 mapping decisions).
   */
  uid: string;

  /**
   * Common Name — "Given Family" format. Maps to SCIM `name.formatted`.
   * May be the only name token for single-name users (Madonna case).
   */
  cn: string;

  /** First name. Maps to SCIM `name.givenName`. May be empty string. */
  givenName: string;

  /**
   * Last name. Maps to SCIM `name.familyName`. NULL for single-token names
   * (Madonna case) — the SCIM mapping omits `name.familyName` entirely
   * rather than emitting null per docs/patterns/ldap.md §4.
   */
  sn: string | null;

  /** Primary email address. Maps to SCIM `emails[primary=true].value`. */
  mail: string;

  /**
   * HR employment ID. Maps to enterprise extension `employeeNumber`.
   * Optional — omit from SCIM schemas[] when null per patterns/ldap.md §2.
   */
  employeeNumber: string | null;

  /** Job title. Maps to enterprise schema extension `title`. */
  title: string | null;

  /** Organizational department. Maps to enterprise extension `department`. */
  department: string | null;

  /**
   * Active flag — THE lifecycle signal. Soft-delete policy (ticket OKT-10
   * lifecycle_policy: soft_delete) means rows are NEVER deleted; deactivation
   * flips this to false. See docs/okta-dialect.md §3.
   */
  enabled: boolean;

  /**
   * Group DNs (e.g. "cn=engineers,ou=groups,dc=acme-hr,dc=example,dc=com").
   * Empty array when user belongs to no groups.
   */
  memberOf: string[];

  /** ISO-8601 timestamp; server-stamped on every mutation. */
  lastModified: string;
}

/**
 * POST /users input shape — server stamps `lastModified` on insert.
 */
export type AcmeHrSystemUserCreate = Omit<AcmeHrSystemUser, "lastModified">;

/**
 * PATCH /users/:uid input shape. `uid` is immutable (renaming would break
 * Okta's provisioning identity correlation via externalId per
 * docs/okta-dialect.md §11.5) — excluded from patch shape on purpose.
 */
export type AcmeHrSystemUserPatch = Partial<
  Omit<AcmeHrSystemUser, "uid" | "lastModified">
>;