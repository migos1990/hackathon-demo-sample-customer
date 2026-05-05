/**
 * BigCorpHR native user model — LDAP-shaped.
 *
 * This is NOT a SCIM schema. The SCIM connector (mapping.ts) translates
 * between this shape and the SCIM 2.0 User object. Field names match
 * the LDAP-pattern documented in docs/attribute-mapping-patterns.md
 * Pattern 1 and in ticket SCIM-LIVE-PROBE (user_model_source: ldap).
 *
 * Field choices mirror the sample payload from docs/attribute-mapping-
 * patterns.md Pattern 1 §1 (Source-schema shape), adapted for BigCorpHR.
 */

export interface BigCorpHrUser {
  /**
   * Primary key — LDAP `uid`. Immutable after creation.
   * Maps to SCIM `id` AND `userName` (LDAP-backed SCIM convention;
   * see mapping.ts header + okta-dialect.md §11.5 on externalId semantics).
   */
  uid: string;

  /**
   * Common Name ("Given Family"). Maps to SCIM `name.formatted`.
   * Written on create by the connector; updated when givenName or sn changes.
   */
  cn: string;

  /** First name — SCIM `name.givenName`. */
  givenName: string;

  /**
   * Surname — SCIM `name.familyName`. Null for single-token names (Madonna
   * case). When null, the connector omits `name.familyName` rather than
   * emitting null, per mapping.ts and docs pattern §4.
   */
  sn: string | null;

  /**
   * Primary email. SCIM `emails[primary=true].value`.
   * Required — BigCorpHR rejects creates without a mail value.
   */
  mail: string;

  /** HR employment ID. Maps to enterprise extension `employeeNumber`. */
  employeeNumber: string | null;

  /** Job title. Maps to enterprise extension `title`. */
  title: string | null;

  /** Organisational department. Maps to enterprise extension `department`. */
  department: string | null;

  /**
   * Active flag — THE lifecycle signal. Soft-delete policy (ticket
   * SCIM-LIVE-PROBE): row is never deleted; deactivation flips this false.
   * Per okta-dialect.md §3: Okta sends PATCH active:false for deprovisioning.
   */
  enabled: boolean;

  /**
   * Group DNs this user belongs to.
   * e.g. "cn=engineers,ou=groups,dc=bigcorp-hr,dc=example,dc=com"
   * Not yet surfaced in SCIM layer (group push not in required_ops for
   * this ticket). Retained in the type for completeness / future use.
   */
  memberOf: string[];

  /**
   * ISO-8601 timestamp — BigCorpHR writes this on every mutation.
   * Maps to SCIM `meta.lastModified` (and `meta.created` as approximation
   * when a separate createdAt is absent — per okta-dialect.md §11.6).
   */
  lastModified: string;
}

/**
 * Input shape for POST /users — server-managed fields omitted.
 * `lastModified` is stamped by BigCorpHR on insert; connector must not send it.
 */
export type BigCorpHrUserCreate = Omit<BigCorpHrUser, "lastModified">;

/**
 * PATCH delta — any subset of mutable fields.
 * `uid` is immutable and intentionally absent (renaming would break
 * Okta's provisioning identity via okta-dialect.md §11.5 externalId drift).
 * `memberOf` is managed via group operations, not user PATCH, per
 * okta-dialect.md §5.
 */
export type BigCorpHrUserPatch = Partial<
  Omit<BigCorpHrUser, "uid" | "lastModified" | "memberOf">
>;