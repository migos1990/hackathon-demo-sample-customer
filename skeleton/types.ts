/**
 * Shared SCIM 2.0 TypeScript types. Scoped to the subset our skeleton
 * and store actually handle; extend as endpoints are added.
 *
 * Sources:
 *   - RFC 7643 §4 (Core Schema) for User / Group shape
 *   - RFC 7644 §3.12 (Error) for error envelope
 *   - okta-dialect.md §10 for required fields
 */

export interface ScimMeta {
  resourceType: "User" | "Group" | "ServiceProviderConfig" | "ResourceType";
  created?: string; // ISO 8601
  lastModified?: string; // ISO 8601
  location?: string;
  version?: string;
}

export interface ScimEmail {
  value: string;
  type?: "work" | "home" | "other";
  primary?: boolean;
  display?: string;
}

export interface ScimName {
  givenName?: string;
  familyName?: string;
  middleName?: string;
  honorificPrefix?: string;
  honorificSuffix?: string;
  formatted?: string;
}

/**
 * Input shape for creating a user — server assigns id + meta.
 * RFC 7643 says userName is required for User; we keep it optional here
 * because the PATCH flow sometimes sees userless partial bodies. Store
 * layer validates required fields at the boundary.
 */
export interface ScimUser {
  schemas: string[];
  id?: string;
  externalId?: string; // SCIM server's ID stored IN Okta per okta-dialect.md §11.5
  userName?: string;
  name?: ScimName;
  displayName?: string;
  emails?: ScimEmail[];
  active?: boolean;
  locale?: string;
  meta?: ScimMeta;
  /**
   * Customer schema-extension fields (e.g. enterprise extension
   * urn:ietf:params:scim:schemas:extension:enterprise:2.0:User) live here
   * as a namespaced record. Kept out of the base interface so TS can narrow
   * cleanly without an index signature polluting every property access.
   */
  extensions?: Record<string, Record<string, unknown>>;
}

/**
 * A ScimUser that has been persisted — guarantees `id` and `meta` are set.
 * Returned by store.create() and store.get(). Callers can assume these
 * fields without narrowing.
 */
export type StoredUser = ScimUser & { id: string; meta: ScimMeta };
