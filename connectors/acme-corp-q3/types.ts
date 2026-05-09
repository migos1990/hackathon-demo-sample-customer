/**
 * Native type definitions for the AcmeCorpQ3 HR API.
 *
 * This is NOT a SCIM schema. The SCIM connector translates between these
 * LDAP-flavored shapes and the SCIM 2.0 User model that Okta speaks.
 * Attribute mapping lives in mapping.ts.
 *
 * Source model: LDAP-shaped (uid/cn/givenName/sn/mail/enabled pattern).
 * See docs/patterns/ldap.md and ticket OKT-57.
 *
 * Lifecycle policy: soft_delete — the `enabled` flag is the ONLY lifecycle
 * signal. User rows are NEVER deleted. Both PATCH active:false and
 * DELETE /Users/:id resolve to enabled=false per okta-dialect.md §3.
 */

export interface AcmeCorpQ3User {
  /**
   * Primary key. Immutable. Okta's SCIM `id` and `userName` both map here.
   * Using uid as both is the standard LDAP-backed SCIM convention — saves
   * a separate id-lookup table and keeps filter=userName eq round-trips stable.
   */
  uid: string;

  /** Common Name — "Given Family". SCIM name.formatted maps here. */
  cn: string;

  /** First name. SCIM name.givenName. May be empty for single-token names. */
  givenName: string;

  /**
   * Surname. SCIM name.familyName. NULL for single-token names (the
   * "Madonna case" — mapping omits familyName entirely rather than emitting
   * null per pattern ldap.md §5).
   */
  sn: string | null;

  /** Primary email. SCIM emails[primary=true].value. */
  mail: string;

  /**
   * HR employment ID. SCIM enterprise extension employeeNumber.
   * Optional — omit enterprise extension block when all enterprise fields are null.
   */
  employeeNumber: string | null;

  /** Job title. SCIM enterprise extension title. */
  title: string | null;

  /** Department. SCIM enterprise extension department. */
  department: string | null;

  /**
   * Lifecycle flag. Soft-delete policy (ticket OKT-57 lifecycle_policy=soft_delete):
   *   - PATCH active:false → PATCH this field false, row retained
   *   - DELETE /Users/:id  → PATCH this field false, row retained (same outcome)
   * Never DELETE the row from this system. Seven-year retention requirement.
   */
  enabled: boolean;

  /** Group DNs. SCIM groups[].display list maps here. */
  memberOf: string[];

  /**
   * ISO-8601 timestamp; the target API stamps this on every mutation.
   * Doubles as both meta.lastModified and meta.created in SCIM (no separate
   * createdAt field in this source per ticket OKT-57).
   */
  lastModified: string;
}

/**
 * POST /users request body — all fields except server-managed lastModified.
 */
export type AcmeCorpQ3UserCreate = Omit<AcmeCorpQ3User, "lastModified">;

/**
 * PATCH /users/:uid request body — any mutable subset.
 * uid is immutable; omitted here intentionally (renaming would break Okta's
 * provisioning identity).
 */
export type AcmeCorpQ3UserPatch = Partial<Omit<AcmeCorpQ3User, "uid" | "lastModified">>;