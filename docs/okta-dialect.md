# Okta SCIM Dialect — Tribal Knowledge Doc

**Status:** v0 — skeleton with RFC/public-doc baseline. Tribal knowledge annotations pending (search for `[LOUIS TO FILL]`).

**Purpose:** capture what we know about how Okta ACTUALLY behaves as a SCIM client, beyond what RFC 7644 specifies or what Okta's public docs make obvious. This file is the single largest piece of IP in the harness — every generated SCIM server reads this as context.

**Sources & citation discipline (SILVER LAW):**
- RFC 7644 (SCIM 2.0 Protocol): <https://datatracker.ietf.org/doc/html/rfc7644>
- RFC 7643 (SCIM 2.0 Core Schema): <https://datatracker.ietf.org/doc/html/rfc7643>
- Okta SCIM Provisioning Integration Overview: <https://developer.okta.com/docs/guides/scim-provisioning-integration-overview/main/>
- Okta "Build a SCIM Provisioning Integration": <https://developer.okta.com/docs/guides/scim-provisioning-integration-prepare/main/>
- Okta SCIM 2.0 Test Utility spec: <https://developer.okta.com/standards/SCIM/>

Every CLAIM in this doc must cite one of: RFC, Okta docs, or a captured payload in `../fixtures/okta-payloads/`. Claims without citation get flagged as `[UNVERIFIED]` per TRUTH LAW.

---

## Table of Contents

1. [PATCH operation quirks](#1-patch-operation-quirks)
2. [Filter expression patterns](#2-filter-expression-patterns)
3. [Soft vs hard delete](#3-soft-vs-hard-delete)
4. [`active` attribute behavior](#4-active-attribute-behavior)
5. [Group membership updates](#5-group-membership-updates)
6. [Attribute deprovisioning on deactivation](#6-attribute-deprovisioning-on-deactivation)
7. [Pagination](#7-pagination)
8. [Error envelope](#8-error-envelope)
9. [Authentication & authorization](#9-authentication--authorization)
10. [Schema discovery](#10-schema-discovery)
11. [Known edge cases & gotchas](#11-known-edge-cases--gotchas)

---

## 1. PATCH operation quirks

### What RFC 7644 specifies

[RFC 7644 §3.5.2](https://datatracker.ietf.org/doc/html/rfc7644#section-3.5.2) defines PATCH with three operations: `add`, `remove`, `replace`. Operation target is an attribute path with optional filter expression: `path: "emails[type eq \"work\"].value"`.

### What Okta emits in practice

[LOUIS TO FILL — what subset of PATCH operations does Okta actually use? Have you seen Okta emit `remove` operations, or does it only `replace`? Does Okta use filter-path expressions, or does it always target full attributes? Cite a fixture once payload corpus lands in Day 2.]

**Known Okta behavior from public docs:**
- Okta's SCIM integration uses PATCH for lifecycle transitions (e.g., deactivating a user flips `active: false`). Okta docs: "Okta updates user profile attributes using a PATCH request" — [source](https://developer.okta.com/docs/guides/scim-provisioning-integration-test/main/#okta-scim-test-account).
- Okta expects `200 OK` with the updated resource on PATCH success (NOT `204 No Content`). RFC 7644 §3.5.2 allows either; Okta prefers 200 + body. `[UNVERIFIED — confirm with fixture]`

### Anti-patterns from past engagements

[LOUIS TO FILL — what PATCH misimplementations have you seen cause Okta provisioning to fail? Examples: server only implements `replace`, or applies PATCH operations in wrong order, or silently drops unknown paths.]

### Code guidance for generated servers

- MUST support all three operations: `add`, `remove`, `replace`. Even if Okta only uses one today, future Okta versions may use all three.
- MUST handle path expressions with filters (e.g., `emails[type eq "work"].value`) — write a proper path parser, not regex.
- MUST return `200 OK` with the updated resource body (not `204`).
- MUST be idempotent where RFC allows — e.g., `add` to an already-present value should succeed without duplication for single-valued attributes.

---

## 2. Filter expression patterns

### What RFC 7644 specifies

[RFC 7644 §3.4.2.2](https://datatracker.ietf.org/doc/html/rfc7644#section-3.4.2.2) defines filter grammar: attribute operators (`eq`, `ne`, `co`, `sw`, `ew`, `gt`, `ge`, `lt`, `le`, `pr`), logical operators (`and`, `or`, `not`), grouping with parens, complex attribute filters with `[...]`.

### What Okta emits in practice

[LOUIS TO FILL — what filter shapes does Okta actually send? Simple `userName eq "x"` only, or does Okta emit complex filters like `(active eq true) and (meta.lastModified gt "2026-01-01T00:00:00Z")`? Cite fixtures.]

**Known from public docs:**
- Okta's SCIM client queries by `userName eq` for dedup / conflict detection on provisioning — [source](https://developer.okta.com/docs/guides/scim-provisioning-integration-test/main/). `[UNVERIFIED — confirm with fixture]`
- Okta supports retrieving a specific user via `GET /Users?filter=userName eq "x"` as the canonical lookup pattern.

### Filter shapes to implement at minimum

- `userName eq "value"` — most common
- `externalId eq "value"` — for ID reconciliation
- `emails[type eq "work"].value eq "foo@bar.com"` — complex attribute filter (for apps that key on email)
- `active eq true` — for listing active users

### Anti-patterns from past engagements

[LOUIS TO FILL — examples where custom SCIM server's filter parser couldn't handle a shape Okta sent.]

### Code guidance

- Build a proper recursive-descent parser for filter expressions. Don't regex-match.
- Reject unsupported operators with `400 Bad Request` + `scimType: "invalidFilter"` per RFC 7644 §3.12.
- Log the raw filter string in structured logs (redacted if values look PII-shaped) for debugging.

---

## 3. Soft vs hard delete

### What RFC 7644 specifies

[RFC 7644 §3.6](https://datatracker.ietf.org/doc/html/rfc7644#section-3.6) defines `DELETE /Users/{id}` with `204 No Content` on success. The spec does NOT mandate soft-delete; that's implementation-defined.

### What Okta emits in practice

[LOUIS TO FILL — when does Okta use DELETE vs PATCH-to-deactivate? Does Okta hard-delete on unassignment, or only on full deprovisioning? Do we handle DELETE the same way across all customer apps?]

**Known from public docs:**
- Okta's default provisioning behavior for "deprovision" (unassignment from the app) is often a PATCH with `active: false`, NOT a DELETE. — [source](https://developer.okta.com/docs/guides/scim-provisioning-integration-test/main/)
- Some customer apps want hard-delete on unassignment; this is configured Okta-side via the "Deprovisioning" settings on the app integration.

### The three customer-expected lifecycles

Document which the customer wants in the ticket template (Section 5 of ticket template). Server behavior differs:

| Customer policy | DELETE handler | PATCH `active: false` handler |
|-----------------|----------------|-------------------------------|
| Hard delete on unassign | Delete row; `204` | PATCH also hard-deletes; `200` with `active: false` body |
| Soft delete / deactivate | Mark `active: false` + `status: deleted`; `204` | Mark `active: false`; `200` |
| Archive (retain + lock) | Move to archive table; `204` | Mark `active: false` + archive; `200` |

### Anti-patterns

[LOUIS TO FILL — cases where ambiguous delete semantics caused production issues.]

### Code guidance

- The ticket template's `lifecycle_requirements` field MUST resolve to one of: `hard_delete` / `soft_delete` / `archive`. The generated server branches on this.
- DELETE handler AND PATCH-to-inactive handler MUST be consistent with the customer's chosen policy. Tests assert both paths behave the same way for the same customer policy.

---

## 4. `active` attribute behavior

### What RFC 7643 specifies

[RFC 7643 §4.1.1](https://datatracker.ietf.org/doc/html/rfc7643#section-4.1.1): `active` is a boolean on User resources. "A Boolean value indicating the User's administrative status."

### What Okta does with `active`

[LOUIS TO FILL — does Okta ever create a user with `active: false` from the outset? When does Okta flip `active` back to `true` (reactivation) and does the server need to restore attributes?]

**Known from public docs:**
- Okta flips `active: false` on deprovisioning via the `active` flag (see Section 3 above).
- Reactivation: Okta PATCHes `active: true`; the server should restore the user to a usable state. Whether past attributes restore depends on the customer's policy in Section 3.

### Code guidance

- `active: false` MUST cause the user to stop being returned on unfiltered `GET /Users` (unless explicitly requested with `includeInactive` or an equivalent filter).
- Server MUST reject auth/login attempts for `active: false` users if the customer app uses the SCIM server for authn (rare but happens).
- Reactivation MUST be idempotent: PATCH `active: true` on an already-active user returns `200` with current body, no error.

---

## 5. Group membership updates

### What RFC 7644 specifies

Groups have a `members` multi-valued attribute. [RFC 7644 §3.5.2 / §3.4.2.3](https://datatracker.ietf.org/doc/html/rfc7644#section-3.5.2) covers adding/removing members via PATCH on `/Groups/{id}`.

### What Okta emits in practice

[LOUIS TO FILL — does Okta PATCH `/Groups/{id}` with `add`/`remove` ops, or does Okta PUT the whole group? Does Okta ever try PATCH on `/Users/{id}` to update group memberships (this is allowed by RFC but rare)?]

**Known from public docs:**
- Okta's "group push" feature PATCHes groups. Member-add uses `op: add, path: "members"`, member-remove uses `op: remove, path: "members[value eq \"user-id\"]"`. — [source](https://developer.okta.com/docs/guides/scim-provisioning-integration-test/main/). `[UNVERIFIED — confirm with fixture]`

### Anti-patterns

[LOUIS TO FILL — group push failures you've seen: race conditions, deleted-user-in-group, group-not-found on add.]

### Code guidance

- PATCH `add` to `members` MUST handle the case where the user doesn't exist yet (return 400 with specific scimType, or create the member if your policy supports it — but default is reject).
- PATCH `remove` of a non-present member MUST be idempotent (200 with unchanged body, not 404 or error).
- Never cascade: removing a user from a group does NOT delete the user. Removing a group does NOT deactivate members.

---

## 6. Attribute deprovisioning on deactivation

### What RFC 7644 specifies

Nothing specific. Deactivation is implementation-defined.

### What Okta expects

[LOUIS TO FILL — when Okta deactivates a user (`active: false`), does Okta clear specific attributes (like `emails`, `phoneNumbers`) in the same PATCH, or does it leave them intact? Does customer app policy expect the server to clear them on deactivation regardless? This is compliance-relevant (GDPR / data minimization).]

### Code guidance

- Document the customer's attribute-retention policy in the generated runbook: what gets cleared vs. retained on deactivation.
- If the customer requires clearing: server MUST zero the specified attributes in the same transaction as the `active: false` flip, not as a separate step (to avoid partial-state windows).

---

## 7. Pagination

### What RFC 7644 specifies

[RFC 7644 §3.4.2.4](https://datatracker.ietf.org/doc/html/rfc7644#section-3.4.2.4): `startIndex` (1-based) + `count` + response fields `totalResults`, `startIndex`, `itemsPerPage`, `Resources[]`. Cursor-based pagination is NOT standardized.

### What Okta sends

[LOUIS TO FILL — what `count` value does Okta request? 100? 200? Does Okta paginate through the whole list on initial import, and what's the expected total-time-to-sync?]

**Known from public docs:**
- Okta's default page size is 100. — [source](https://developer.okta.com/docs/guides/scim-provisioning-integration-test/main/#test-user-imports). `[UNVERIFIED — confirm with fixture]`

### Code guidance

- MUST return `totalResults` accurately even when `count` caps the response. Okta uses `totalResults` to decide whether to paginate.
- `startIndex: 0` MUST be treated as `startIndex: 1` per RFC (Okta might send 0 or 1 depending on version).
- If `count` exceeds a server-side max (e.g., 200), clamp and set `itemsPerPage` to the clamped value.

---

## 8. Error envelope

### What RFC 7644 specifies

[RFC 7644 §3.12](https://datatracker.ietf.org/doc/html/rfc7644#section-3.12) defines error response:
```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
  "status": "400",
  "scimType": "invalidFilter",
  "detail": "Filter expression was not understood"
}
```

`scimType` values: `invalidFilter`, `tooMany`, `uniqueness`, `mutability`, `invalidSyntax`, `invalidPath`, `noTarget`, `invalidValue`, `invalidVers`, `sensitive`.

### What Okta expects

[LOUIS TO FILL — has Okta ever failed on a non-conformant error envelope? Any specific scimType values Okta keys off for retry logic?]

### Code guidance

- MUST emit the full error envelope on 4xx errors. Plain-text or HTML error bodies confuse Okta.
- MUST include `scimType` for 400-class errors. Okta uses it for retry + surface-in-UI decisions.
- MUST use `409 Conflict` + `scimType: "uniqueness"` for userName collisions. Okta treats this as dedup signal, not a hard error.

---

## 9. Authentication & authorization

### Auth methods Okta's SCIM client supports

- Bearer token (HTTP header `Authorization: Bearer <token>`)
- Basic auth (rare, legacy)
- OAuth 2.0 client credentials flow (for SCIM servers that front OAuth-protected APIs)

[LOUIS TO FILL — which auth method dominates in practice? What's the secret-rotation story Okta offers (can the admin rotate the bearer token without breaking in-flight provisioning)?]

### Code guidance

- Pluggable auth middleware. Default: bearer token from env var. OAuth 2.0 client credentials as a secondary implementation option.
- MUST reject requests with missing/invalid auth with `401 Unauthorized` (not `403 Forbidden`).
- Auth MUST be enforced on every data endpoint (`/Users/*`, `/Groups/*`). Metadata endpoints (`/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`) MAY be open but better to require auth.

---

## 10. Schema discovery

### What RFC 7644 specifies

[RFC 7644 §4](https://datatracker.ietf.org/doc/html/rfc7644#section-4) requires `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` endpoints. Okta queries these on first connection to understand the server's capabilities.

### What Okta does

[LOUIS TO FILL — does Okta call these endpoints on every import job, or only on initial app connection? Any specific capability fields Okta keys off of (e.g., `filter.supported`, `patch.supported`)?]

### Code guidance

- MUST return the full RFC-spec response shape, not abbreviated. Okta parses strictly.
- `ServiceProviderConfig.patch.supported: true` — Okta skips apps that don't support PATCH.
- `ServiceProviderConfig.filter.supported: true` + `maxResults: <N>` — honest about your filter capability.

---

## 11. Known edge cases & gotchas

Each entry gets its own subsection once tribal knowledge lands. Candidate topics (brainstorm Louis-to-fill list):

- [LOUIS TO FILL] — Timezone / timestamp format quirks (Okta's `meta.lastModified` vs your server's)
- [LOUIS TO FILL] — Case-sensitivity in `userName` comparisons
- [LOUIS TO FILL] — Unicode / character encoding in user attributes
- [LOUIS TO FILL] — Large-attribute handling (profile photos, long descriptions)
- [LOUIS TO FILL] — Schema extension handling (`urn:ietf:params:scim:schemas:extension:enterprise:2.0:User`) — which custom fields Okta actually sends in practice
- [LOUIS TO FILL] — Retry / idempotency semantics (if a PATCH times out and Okta retries, will the server handle it correctly?)
- [LOUIS TO FILL] — Rate limiting — does Okta back off on 429? What rate does it send at during a full import?
- [LOUIS TO FILL] — Multi-value attribute primary flag (`emails[primary eq true]`) — Okta's expectations
- [LOUIS TO FILL] — Reserved attribute names / collisions with customer source-schema field names

---

## Appendix: How to annotate this doc

1. Replace every `[LOUIS TO FILL]` marker with real tribal knowledge.
2. Every concrete claim you add must cite a fixture filename in `../fixtures/okta-payloads/` (once the corpus exists), a dated engagement note, or a public Okta doc URL.
3. If a claim is knowledge you hold but can't currently cite, wrap it: `[UNVERIFIED — heard from <colleague> <date>; confirm with fixture]`. This is the honest escape hatch per TRUTH LAW, not a silent assertion.
4. When you capture a fixture in Day 2 that validates or contradicts something here, update the section with a reference.
5. Commit each section's annotation as a separate commit — `docs(dialect): section N tribal knowledge` — so the history shows what-we-know-over-time.

## Out of scope for v0

- Okta Identity Engine (OIE) vs Classic engine differences in SCIM emission — noted; add a section if these diverge.
- SCIM 1.1 legacy behavior — Okta docs say 2.0 only.
- SSO / SAML-only integrations that don't emit SCIM — out of this harness' scope entirely.
