/**
 * Acme HR System — LDAP-shaped user model.
 *
 * This is NOT a SCIM schema. The SCIM connector at `connectors/acme-hr-system/`
 * translates between SCIM 2.0 (what Okta speaks) and this LDAP-flavored shape
 * (what Acme HR System exposes at https://api.acme-hr.example.com).
 *
 * Field choices mirror the LDAP-pattern document at
 * `docs/patterns/ldap.md §1` and the reference implementation at
 * `connectors/acme-hr/types.ts`.
 *
 * Ticket: OKT-10  customer_slug: acme-hr-system
 */

export interface AcmeHrSystemUser {
  /** Primary key — matches LDAP `uid`; SCIM `userName` maps to this. */
  uid: string;
  /** Common Name — "Given Family"; SCIM `name.formatted` maps here. */
  cn: string;
  /** First name — SCIM `name.givenName`. */
  givenName: string;
  /**
   * Last name — SCIM `name.familyName`. May be null for single-token names
   * (the "Madonna case" — see mapping.ts and docs/patterns/ldap.md §4).
   */
  sn: string | null;
  /** Primary email — SCIM `emails[primary=true].value`. */
  mail: string;
  /** Employment ID — SCIM enterprise extension `employeeNumber`. */
  employeeNumber: string | null;
  /** Job title — SCIM `title`. */
  title: string | null;
  /** Department — SCIM enterprise extension `department`. */
  department: string | null;
  /**
   * Lifecycle flag. Ticket OKT-10 specifies `lifecycle_policy: soft_delete`:
   * Okta sends PATCH `active: false` → connector sets `enabled: false` on the
   * row; the row is NEVER deleted. See okta-dialect.md §3 and store.ts.
   */
  enabled: boolean;
  /** Group DNs — informational; group push not enabled in OKT-10. */
  memberOf: string[];
  /** ISO-8601 timestamp; target stamps on every mutation. */
  lastModified: string;
}

/**
 * Input for POST /users — same as AcmeHrSystemUser minus server-managed
 * fields. `lastModified` is stamped on insert by the target.
 */
export type AcmeHrSystemUserCreate = Omit<AcmeHrSystemUser, "lastModified">;

/**
 * PATCH input — any subset of mutable fields. `uid` is immutable (renaming
 * would break Okta's provisioning identity correlation). `lastModified` is
 * server-managed.
 */
export type AcmeHrSystemUserPatch = Partial<
  Omit<AcmeHrSystemUser, "uid" | "lastModified">
>;