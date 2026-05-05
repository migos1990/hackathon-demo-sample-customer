# user-filter-username — notes

**Provenance:** `[SYNTHETIC — derived from Okta public docs]`
**Source:** <https://developer.okta.com/docs/guides/scim-provisioning-integration-test/main/#retrieve-users>
**Retrieved:** 2026-05-04

## What this fixture exercises

- `GET /scim/v2/Users?filter=userName eq "<value>"`
- Okta's canonical dedup / lookup pattern — run BEFORE a create to check for existing users
- Returns a ListResponse (`urn:ietf:params:scim:api:messages:2.0:ListResponse`) with 0 or 1 Resources
- Pagination fields (`totalResults`, `startIndex`, `itemsPerPage`) populated even when a single match

## What the generated server MUST do

- Parse the `filter` query parameter — URL-decoded `userName eq "user-001@example.com"`
- Execute a case-sensitive (per RFC 7644 default) match against stored userName values. Note: `userName` per RFC 7643 §4.1.1 is typically case-insensitive in practice for most customers; document which behavior the customer wants.
- Return a `ListResponse` envelope — even with 0 results (empty `Resources` array, `totalResults: 0`)
- Populate `startIndex` and `itemsPerPage` accurately so Okta can decide whether to paginate
- If the filter expression can't be parsed: return `400 Bad Request` + `scimType: invalidFilter` per RFC 7644 §3.12

## Anti-patterns the replay test should catch

- Server returning a bare `User` object instead of a `ListResponse` envelope
- Server ignoring the filter and returning all users
- Server returning 404 instead of a ListResponse with `totalResults: 0` for no match
- Server sending `startIndex: 0` — per RFC 7644 §3.4.2.4, pagination is 1-based
- Server case-sensitivity behavior drifting from what the customer's ticket specified

## Related dialect doc sections

- `docs/okta-dialect.md` §2 (Filter expression patterns — canonical `userName eq` shape)
- `docs/okta-dialect.md` §7 (Pagination — ListResponse fields mandatory)
- `docs/okta-dialect.md` §8 (Error envelope — `scimType: invalidFilter` for unparseable filters)
- `docs/okta-dialect.md` §10 (Schema discovery — `ServiceProviderConfig.filter.supported: true` required)
