/**
 * AcmeHR-lite — LDAP-shaped user model.
 *
 * This is NOT a SCIM schema. The whole point of AcmeHR-lite as a demo target
 * is that the generated SCIM connector has to translate between SCIM (what
 * Okta speaks) and this LDAP-flavored shape (what AcmeHR exposes). Attribute
 * mapping work is the visible value-add.
 *
 * Field choices mirror the sample payload in
 * `ticket-templates/new-scim-connector.md:83-102` so the template and the
 * target app describe the same customer analog.
 */

export interface AcmeHrUser {
  /** Primary key — matches `uid` in LDAP; SCIM `userName` maps to this. */
  uid: string;
  /** Common Name — "Given Family"; SCIM `name.formatted` maps here. */
  cn: string;
  /** First name — SCIM `name.givenName`. */
  givenName: string;
  /** Last name — SCIM `name.familyName`. May be absent for single-token names. */
  sn: string | null;
  /** Primary email — SCIM `emails[primary=true].value`. */
  mail: string;
  /** Employment ID — SCIM enterprise extension `employeeNumber`. */
  employeeNumber: string | null;
  /** Job title — SCIM `title`. */
  title: string | null;
  /** Department — SCIM enterprise `department`. */
  department: string | null;
  /**
   * Active flag — THE lifecycle signal. Generated connector translates
   * SCIM `active: false` (deactivation) into a PATCH that sets this false.
   * Never delete; AcmeHR retains user rows for 7-year compliance audit.
   */
  enabled: boolean;
  /** Group DNs — SCIM `groups[].display` (list) maps here. */
  memberOf: string[];
  /** ISO-8601 timestamp; AcmeHR writes on every mutation. */
  lastModified: string;
}

/**
 * Input shape for POST /users — same as AcmeHrUser minus server-managed
 * fields. `lastModified` is stamped on insert.
 */
export type AcmeHrUserCreate = Omit<AcmeHrUser, "lastModified">;

/**
 * PATCH input — any subset of mutable fields. `uid` is immutable; omit from
 * Patch shape on purpose (renaming would break provisioning identity).
 */
export type AcmeHrUserPatch = Partial<Omit<AcmeHrUser, "uid" | "lastModified">>;
