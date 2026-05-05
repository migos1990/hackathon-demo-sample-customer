# user-create — notes

**Provenance:** `[SYNTHETIC — derived from Okta public docs]`
**Source:** <https://developer.okta.com/docs/guides/scim-provisioning-integration-test/main/#create-a-user>
**Retrieved:** 2026-05-04

## What this fixture exercises

- `POST /scim/v2/Users` with a new user Okta wants to create
- Schema `urn:ietf:params:scim:schemas:core:2.0:User`
- Standard user profile fields: `userName`, `name.givenName`, `name.familyName`, `emails[]`, `displayName`, `locale`, `externalId`
- `active: true` set from the start
- Server returns `201 Created` + full user resource including server-generated `id` and `meta`

## What the generated server MUST do

- Validate required fields per RFC 7643 (userName is mandatory)
- Generate a server-side `id` (opaque; Okta uses this for subsequent calls)
- Populate `meta.resourceType`, `meta.created`, `meta.lastModified`, `meta.location`
- Return `201` with the created resource body
- If a user with the same `userName` already exists: return `409 Conflict` + `scimType: uniqueness` per RFC 7644 §3.12

## Sanitization notes

- Original capture would include a real bearer token in `Authorization` header — redacted to `<TOKEN>` placeholder
- Real Okta opaque IDs redacted to `00u00000000000000001` family
- Real emails redacted to `user-001@example.com`
- External ID (UUID) redacted deterministically

## Related dialect doc sections

- `docs/okta-dialect.md` §2 (Filter expression patterns — for the dedup query Okta runs before create)
- `docs/okta-dialect.md` §8 (Error envelope — for the 409 uniqueness case)
- `docs/okta-dialect.md` §10 (Schema discovery — `/Schemas` is queried before first create)
