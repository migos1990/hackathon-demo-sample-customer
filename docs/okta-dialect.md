# Okta SCIM Dialect — Tribal Knowledge Doc

**Status:** v1 — grounded in Okta official docs + RFC 7644/7643 + field-confirmed patterns from past engagements. Replaces v0 skeleton.

**Purpose:** capture how Okta ACTUALLY behaves as a SCIM client, beyond what RFC specifies or what public docs make obvious. This file is the single largest piece of IP in the harness — every generated SCIM server reads this as context.

## Sources & citation discipline (SILVER LAW)

Every load-bearing claim in this doc cites one of:

**RFCs (baseline spec):**
- [RFC 7644 — SCIM 2.0 Protocol](https://datatracker.ietf.org/doc/html/rfc7644) (retrieved 2026-05-04)
- [RFC 7643 — SCIM 2.0 Core Schema](https://datatracker.ietf.org/doc/html/rfc7643) (retrieved 2026-05-04)

**Okta official docs (authoritative for Okta's behavior):**
- [Okta SCIM concepts](https://developer.okta.com/docs/concepts/scim/) (retrieved 2026-05-04)
- [Prepare a SCIM API service](https://developer.okta.com/docs/guides/scim-provisioning-integration-prepare/main/) (retrieved 2026-05-04)
- [Test your SCIM integration](https://developer.okta.com/docs/guides/scim-provisioning-integration-test/main/) (retrieved 2026-05-04)
- [Okta SCIM 2.0 protocol reference](https://developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20/) (retrieved 2026-05-04) — the authoritative endpoint + payload reference. The old URL at `/docs/reference/scim/scim-20/` redirects here.
- [Okta SCIM 2.0 SPEC Test suite (JSON)](https://developer.okta.com/standards/SCIM/SCIMFiles/Okta-SCIM-20-SPEC-Test.json) (retrieved 2026-05-04) — THIS IS THE GATE. The 12 Required Tests + 1 Optional Test in this file determine whether a SCIM server is accepted into the OIN. If you pass this, you pass OIN. If you don't, you fail.

**Field confirmation (tribal knowledge from past engagements):**
- `[FIELD-CONFIRMED]` = Louis has personally seen/hit this in production engagements
- `[UNVERIFIED]` = documented but not yet observed in captured fixtures
- `[OPEN]` = specific behavior detail waiting on more real-payload captures or vendor answer

## Table of Contents

1. [PATCH operation quirks](#1-patch-operation-quirks)
2. [Filter expression patterns](#2-filter-expression-patterns)
3. [Soft vs hard delete — deprovisioning semantics](#3-soft-vs-hard-delete--deprovisioning-semantics)
4. [`active` attribute behavior](#4-active-attribute-behavior)
5. [Group membership updates](#5-group-membership-updates)
6. [Attribute deprovisioning on deactivation](#6-attribute-deprovisioning-on-deactivation)
7. [Pagination](#7-pagination)
8. [Error envelope](#8-error-envelope)
9. [Authentication](#9-authentication)
10. [Schema discovery + required endpoints](#10-schema-discovery--required-endpoints)
11. [Known edge cases & gotchas](#11-known-edge-cases--gotchas)
12. [Appendix: Okta's 13 OIN-gating tests](#12-appendix-oktas-13-oin-gating-tests)

---

## 1. PATCH operation quirks

### What RFC 7644 specifies

[RFC 7644 §3.5.2](https://datatracker.ietf.org/doc/html/rfc7644#section-3.5.2) defines PATCH with three operations — `add`, `remove`, `replace` — targeted by a path expression (optionally with a filter: `emails[type eq "work"].value`).

### What Okta docs say

[Okta SCIM concepts §Update](https://developer.okta.com/docs/concepts/scim/) confirms PATCH is the mechanism for updates in SCIM 2.0 (vs. PUT in 1.1) and references [RFC 7644 §3.5.2](https://datatracker.ietf.org/doc/html/rfc7644#section-3.5.2).

### What Okta sends in practice `[FIELD-CONFIRMED]`

Okta's SCIM client emits all four shapes below. The generated server MUST handle all four:

| Shape | Example | When Okta uses it |
|-------|---------|-------------------|
| `replace` unscoped | `{"op":"replace","value":{"active":false}}` | Deactivation (most common PATCH by volume) |
| `replace` with filter path | `{"op":"replace","path":"emails[type eq \"work\"].value","value":"new@..."}` | Updating a specific multi-valued element |
| `add` multi-valued | `{"op":"add","path":"emails","value":[{...}]}` | Appending to multi-valued attributes without replacing |
| `remove` with filter path | `{"op":"remove","path":"members[value eq \"user-id\"]"}` | Group member removal (common in group push flows) |

### Anti-patterns to catch `[FIELD-CONFIRMED]`

- **PATCH ordering bugs** — applying ops in parallel or reordering. RFC 7644 §3.5.2 requires sequential application in document order. Servers that parallelize multi-op PATCHes corrupt state when ops target overlapping paths. `[FIELD-CONFIRMED — hit in past engagement]`
- **Filter-path parser failures** — servers that regex-match filter paths instead of parsing them fail on nested quotes and whitespace variations in `emails[type eq "work"].value`.
- **Dropping unknown paths silently** — server MUST reject unknown paths with `400 Bad Request` + `scimType: "invalidPath"`, not silently no-op.
- **Status 204 on PATCH** — Okta's test suite (step 14 in the OIN spec) expects `200 OK` with the updated resource body. `204 No Content` is RFC-permitted but Okta parses the response body on PATCH.

### Code guidance for generated servers

- Implement all four shapes above; do not skip `op: remove` even if you can't think of a customer flow that uses it (group push does).
- Write a real path parser, not regex. The filter-path grammar is from [RFC 7644 §3.4.2.2](https://datatracker.ietf.org/doc/html/rfc7644#section-3.4.2.2).
- Apply ops sequentially, never in parallel.
- Return `200` with the full updated resource body.
- For multi-op PATCHes, ALL ops succeed or ALL ops roll back (atomicity — per RFC 7644 §3.5.2 "The server MUST apply all 'Operations' atomically").
- **Multi-op PATCH: YES** — [Okta SCIM 2.0 protocol reference](https://developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20/) shows multi-op examples: `"Operations": [{op: "remove"...}, {op: "add"...}]`. Server MUST handle single and multi-op in the same endpoint. Closes prior `[OPEN]` on this.

---

## 2. Filter expression patterns

### What RFC 7644 specifies

[RFC 7644 §3.4.2.2](https://datatracker.ietf.org/doc/html/rfc7644#section-3.4.2.2) defines the filter grammar: attribute operators (`eq`, `ne`, `co`, `sw`, `ew`, `gt`, `ge`, `lt`, `le`, `pr`), logical operators (`and`, `or`, `not`), grouping with parens, complex attribute filters with `[...]`.

### What Okta sends in practice `[FIELD-CONFIRMED]`

Okta's SCIM client emits these filter shapes in practice:

| Shape | Example | Where it's used |
|-------|---------|-----------------|
| Simple equality | `userName eq "x"` | Canonical dedup lookup before create. Also the OIN test suite's primary filter test (step 4 & 8). |
| Logical AND/OR | `active eq true and department eq "Eng"` | Multi-predicate queries, typically during delta sync |
| Complex attribute | `emails[type eq "work"].value eq "x"` | Secondary keying on email when userName isn't email |
| Temporal | `meta.lastModified gt "2026-01-01T00:00:00Z"` | Incremental/delta imports — only changed users since timestamp |

### Case sensitivity — THE Okta quirk `[FIELD-CONFIRMED — costs hours]`

[Okta's OIN test suite step 16 "Username Case Sensitivity Check"](https://developer.okta.com/standards/SCIM/SCIMFiles/Okta-SCIM-20-SPEC-Test.json) EXPLICITLY tests that `filter=userName eq "SOMEUSER"` returns a **different result** from `filter=userName eq "someuser"` — i.e., Okta's spec test expects CASE-SENSITIVE matching by default.

This contradicts common customer expectation (most customer apps treat userName as case-insensitive). If the customer's source system is case-insensitive, the generated server MUST normalize on write (lowercase at store time) and match case-insensitively — but the OIN test suite will fail this behavior unless you special-case. Resolution: ticket template must capture which behavior the customer wants, and the generated server documents the choice in its runbook.

[FIELD-CONFIRMED — case sensitivity has caused dedup misses and PATCH 404s]

### Anti-patterns `[FIELD-CONFIRMED]`

- Unicode normalization — NFC vs NFD variants of the same logical string silently fail to match. Normalize both stored and incoming userName to NFC on the match path.
- Regex-matching the filter — breaks on escaped quotes and nested brackets.
- Returning a bare `User` on a single-match filter — must always be a `ListResponse` envelope.
- Treating `userName eq "x" AND active eq true` as a parser-level syntax error because the parser doesn't chain `and` properly.

### Code guidance

- Build a proper recursive-descent parser. Don't regex.
- Reject unsupported operators/shapes with `400` + `scimType: "invalidFilter"` per RFC 7644 §3.12.
- Normalize userName comparisons via the customer-chosen policy (case-sensitive per OIN default, OR case-insensitive with NFC normalization per customer ticket).
- Log the raw filter string (redacted for PII) for debugging.
- **Okta's documented filter surface is minimal.** The [Okta SCIM 2.0 protocol reference](https://developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20/) only explicitly commits to `eq` — as in `filter=userName eq "{userName}"` and `filter=displayName eq "{groupName}"`. Other operators (`and`, `or`, `not`, `co`, `sw`, `ew`, `gt`, `ge`, `lt`, `le`, `pr`, `ne`) are NOT explicitly documented. Implications:
  - **OIN minimum:** server MUST support `eq`. Other operators are optional for OIN acceptance.
  - **Production reality:** field-confirmed sightings of logical AND/OR + complex attribute filters + temporal filters. Implement the full RFC 7644 §3.4.2.2 grammar; don't rely on the doc understatement.
  - **What's `[OPEN]` even after doc-review:** whether Okta emits `not`-prefixed filters. Not in the docs. Not yet in our fixtures. Capture on Day 5 if observed.

---

## 3. Soft vs hard delete — deprovisioning semantics

### What Okta docs say

[Okta SCIM concepts §Delete / Deprovision](https://developer.okta.com/docs/concepts/scim/#delete-deprovision) is explicit: Okta's deprovisioning signal is **`PATCH active: false`, NOT `DELETE`**. Quote: *"When an admin deprovisions a user in Okta, the SCIM server receives `active=false`."* Further: *"If an admin deletes a deactivated user profile inside Okta, the user resource inside your SCIM app isn't changed."*

### What this means

Okta does NOT use `DELETE /Users/{id}` at all in the standard lifecycle. The DELETE endpoint may be implemented for edge cases (admin-initiated forced removal on the customer app side) but Okta itself drives lifecycle through the `active` flag.

### Three customer policies we've implemented `[ALL FIELD-CONFIRMED]`

| Policy | DELETE handler | PATCH `active: false` handler | When customer picks this |
|--------|----------------|-------------------------------|--------------------------|
| Hard delete on unassign | Remove row + 204 | Also hard-remove row | Customer wants clean-slate + no audit retention; rare |
| Soft delete / deactivate (default) | Mark `active: false` + retain row + 204 | Mark `active: false` + retain row + 200 | MOST COMMON — customer needs audit trail |
| Archive | Move to archive storage, lock | Move to archive storage, lock | Heavy compliance customers (SOX, GDPR 7-year retention) |

### Anti-patterns `[FIELD-CONFIRMED]`

- Hard-deleting on `active: false` when the customer actually wanted soft-delete — breaks audit.
- DELETE cascading to group memberships — it should NOT. Group memberships are the group's problem, not the user's.
- Inconsistency between DELETE and PATCH paths — same customer policy MUST yield identical outcomes regardless of which endpoint Okta hits.

### Code guidance

- Ticket template's `lifecycle_policy` field MUST resolve to one of `hard_delete` / `soft_delete` / `archive`. The generated server branches on it.
- DELETE handler and PATCH-active-false handler MUST be policy-consistent. Tests assert both paths produce the same end-state for the same policy.
- Generated runbook documents the policy so the customer's app team doesn't override it.

---

## 4. `active` attribute behavior

### What RFC 7643 specifies

[RFC 7643 §4.1.1](https://datatracker.ietf.org/doc/html/rfc7643#section-4.1.1): `active` is a boolean on User. "A Boolean value indicating the User's administrative status."

### What Okta docs say

[Okta SCIM concepts](https://developer.okta.com/docs/concepts/scim/): *"The `active` user attribute represents a user's status, and relates to activating, reactivating, and deactivating a user."* And: *"Okta doesn't pull in a user whose status is set to `active=false`, even in a full import."*

### Field-confirmed reactivation gotcha `[COSTS HOURS]`

When `active: false` + attribute zeroing (§6) runs together, reactivation (PATCH `active: true`) restores the user to being active BUT attributes are empty — user can log in but has no profile, no group memberships, no role. Customer-side app often breaks catastrophically because its code assumes a user with a valid profile exists. [FIELD-CONFIRMED]

Resolution: if the customer does attribute zeroing, reactivation flow MUST re-fetch attributes from the source and re-populate OR block reactivation until the Okta admin re-pushes the user. The ticket template's `deactivation_attribute_clearing` list drives the server's reactivation logic.

### Code guidance

- `active: false` MUST hide the user from unfiltered `GET /Users` (the default list). Supporting `active eq false` filter is optional but useful for admin views.
- Reactivation MUST be idempotent: PATCH `active: true` on an already-active user → 200 with current body, no error.
- If attribute zeroing is configured: reactivation triggers the re-population flow before returning 200. Document this in the runbook.
- Document behavior explicitly — customers will ask.

---

## 5. Group membership updates

### What Okta docs say

[Okta SCIM concepts §Group Push](https://developer.okta.com/docs/concepts/scim/): Group operations include create, update, and delete of groups, plus member add/remove.

### What Okta sends in practice `[FIELD-CONFIRMED]`

Okta's group push emits PATCH on `/Groups/{id}`:

```json
// Add member
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations": [
    {"op": "add", "path": "members", "value": [{"value": "<user-scim-id>"}]}
  ]
}
```

```json
// Remove member
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations": [
    {"op": "remove", "path": "members[value eq \"<user-scim-id>\"]"}
  ]
}
```

Okta does NOT typically PUT the whole group on a member change — that would be lossy.

### Race conditions `[FIELD-CONFIRMED — costs hours]`

Group push is async. Race conditions we've seen:
- **Deleted-user-in-group:** user is deactivated/deleted while a group add-member is in flight. Server receives `add members[{value: deleted-user-id}]` — must decide: reject (400), silently skip (200 but member not added), or resurrect the user. Default: reject with clear `scimType: "invalidValue"`.
- **Group-not-found:** user assigned to a group that wasn't pushed first. Race between group create and user assignment. Server receives PATCH on a nonexistent group. Return 404 with `scimType: "noTarget"`.
- **Double add:** user already in group, Okta retries or races. Server receives `add` for existing member. MUST be idempotent: return 200 with unchanged body.
- **Remove non-member:** symmetric — removing a user not in the group must be idempotent.

### Code guidance

- Multi-valued PATCH ops (both `add` and `remove`) MUST be idempotent on `members`.
- Group not found → 404 + `scimType: "noTarget"`.
- Member-not-found in add → 400 + `scimType: "invalidValue"` (reject by default; don't silently drop).
- Never cascade: removing a user from a group does NOT deactivate the user. Removing a group does NOT deactivate members. The generated test harness asserts this.

---

## 6. Attribute deprovisioning on deactivation

### What RFC says

Nothing specific. Deactivation attribute-handling is implementation-defined.

### What Okta does

Okta's core flip is just `active: false`. Okta does NOT clear other attributes by default — the user's profile stays intact on the SCIM server side.

### Customer-driven attribute clearing `[FIELD-CONFIRMED]`

GDPR / data-minimization customers explicitly require the SCIM server to zero specific attributes (emails, names, phone numbers, employee numbers) on `active: false`. This is a customer-specific requirement, not an Okta behavior — Okta just sends `active: false`; the server decides what else changes.

Policy typically:
- Retain audit identity (`id`, `externalId`, audit timestamps)
- Zero directly-identifying attributes (emails, phoneNumbers, name, photos)
- Retain structural attributes (department, groups — for historical reporting)

### The reactivation tension

See §4 — zeroing + reactivation creates an empty-user problem. Resolution in the ticket template's `deactivation_attribute_clearing` field + reactivation flow.

### Code guidance

- Ticket template's `deactivation_attribute_clearing` list is the contract. Server branches on it.
- Clearing + `active: false` flip MUST happen in the same transaction (atomic) — no partial-state window.
- Document the policy in the customer runbook so the app team knows what's getting zeroed.

---

## 7. Pagination

### What RFC 7644 specifies

[RFC 7644 §3.4.2.4](https://datatracker.ietf.org/doc/html/rfc7644#section-3.4.2.4): `startIndex` (1-based) + `count` + response fields `totalResults`, `startIndex`, `itemsPerPage`, `Resources[]`. Cursor-based pagination is NOT standardized.

### What Okta sends in practice

From the [OIN test suite step 0](https://developer.okta.com/standards/SCIM/SCIMFiles/Okta-SCIM-20-SPEC-Test.json): `GET /Users?count=1&startIndex=1`. Default pagination values per the [Okta SCIM 2.0 protocol reference](https://developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20/): **`count: 100` (maximum), `startIndex: 1`** — both documented as integers (NOT strings). Doc-confirmed, closes prior `[UNVERIFIED]`.

### Code guidance

- MUST return `totalResults` accurately even when `count` caps the response. Okta uses `totalResults` to decide whether to paginate.
- `startIndex: 0` MUST be treated as `startIndex: 1` per RFC (Okta may send either).
- If `count` exceeds a server-side maximum, clamp and set `itemsPerPage` to the clamped value (honest about capacity).
- Omitting `totalResults` breaks Okta's import.

---

## 8. Error envelope

### What RFC 7644 specifies

[RFC 7644 §3.12](https://datatracker.ietf.org/doc/html/rfc7644#section-3.12):

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
  "status": "400",
  "scimType": "invalidFilter",
  "detail": "Filter expression was not understood"
}
```

Valid `scimType` values: `invalidFilter`, `tooMany`, `uniqueness`, `mutability`, `invalidSyntax`, `invalidPath`, `noTarget`, `invalidValue`, `invalidVers`, `sensitive`.

### What Okta expects

[Okta SCIM protocol notes](https://developer.okta.com/docs/api/openapi/okta-scim/guides/) confirm: SCIM 2.0 requires error responses in JSON body using the `urn:ietf:params:scim:api:messages:2.0:Error` schema. HTML or plain-text error bodies confuse Okta's client.

OIN test suite tests:
- Step 14: duplicate create → 409 + `scimType: "uniqueness"`
- Step 20: missing/invalid auth → 401
- Step 22: unknown user ID → 404

### Code guidance

- MUST emit the full envelope on 4xx/5xx errors. No HTML, no plain text.
- `scimType` is REQUIRED on 400-class errors. Okta parses it for retry/surface-in-UI decisions.
- `409 Conflict` + `scimType: "uniqueness"` for userName collisions. Okta treats this as dedup signal, not hard error — this is how Okta decides "user already exists, skip create."

---

## 9. Authentication

### What Okta supports

Per [Prepare a SCIM API service](https://developer.okta.com/docs/guides/scim-provisioning-integration-prepare/main/): Okta's SCIM client supports three authentication methods:

1. **OAuth 2.0 Authorization Code grant flow** — for SCIM servers that front OAuth-protected APIs. Most involved to implement.
2. **Basic Authentication** — username + password, legacy but still supported.
3. **HTTP Header (Bearer token)** — most common. `Authorization: Bearer <token>`.

### Rate limiting

[Okta SCIM concepts](https://developer.okta.com/docs/concepts/scim/) documents: Okta respects `Retry-After` header on 429 responses. Default backoff if header is missing or malformed: 5 minutes. Okta implements exponential backoff, up to 10 retry attempts.

### Code guidance

- Pluggable auth middleware. Default: bearer token from env. OAuth 2.0 secondary.
- Reject unauthenticated requests with `401 Unauthorized` (NOT `403`). OIN test suite step 20 asserts this.
- Enforce auth on EVERY `/Users/*` and `/Groups/*` route. Metadata endpoints (`/ServiceProviderConfig`, `/Schemas`, `/ResourceTypes`) MAY skip auth but should prefer to require it.
- Implement `429 Too Many Requests` with proper `Retry-After` header to signal backoff. Okta's client respects this.
- Rate limiting is REQUIRED on the generated server per OBSERVABILITY LAW (prevents customer app overload during full imports).

---

## 10. Schema discovery + required endpoints

### Required endpoints (per OIN test suite + RFC 7644 §4)

A server that passes the OIN test suite must serve at minimum:

| Endpoint | Method | OIN required? | Purpose |
|----------|--------|----------------|---------|
| `/scim/v2/Users` | GET, POST | Yes | List + create users |
| `/scim/v2/Users/{id}` | GET, PATCH | Yes | Read + update user |
| `/scim/v2/Users/{id}` | PUT, DELETE | Optional | Full replace / hard delete |
| `/scim/v2/Groups` | GET | Optional (required if group push enabled) | List groups |
| `/scim/v2/Groups/{id}` | GET, PATCH | Optional (required if group push enabled) | Read + update group |
| `/scim/v2/ServiceProviderConfig` | GET | Recommended | Describe server capabilities |
| `/scim/v2/ResourceTypes` | GET | Recommended | List resource types |
| `/scim/v2/Schemas` | GET | Recommended | Describe schemas |

### ServiceProviderConfig — what Okta reads

When Okta connects, it reads `/ServiceProviderConfig` once to understand capabilities. Key fields:

```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  "patch": {"supported": true},
  "bulk": {"supported": false, "maxOperations": 0, "maxPayloadSize": 0},
  "filter": {"supported": true, "maxResults": 200},
  "changePassword": {"supported": false},
  "sort": {"supported": false},
  "etag": {"supported": false},
  "authenticationSchemes": [...]
}
```

- `patch.supported: true` — or Okta skips the app for any lifecycle change other than create.
- `filter.supported: true` with honest `maxResults` — prevents Okta from requesting pages it can't process.
- Do NOT claim capabilities you don't support (e.g. `bulk.supported: true` without actually supporting bulk).

### Content-Type nuance `[OBSERVED]`

OIN test suite emits `Content-Type: application/scim+json; charset=utf-8` on GET requests but `Content-Type: application/json` on POST bodies. Server MUST accept both on inbound requests. On outbound responses, return `application/scim+json` consistently.

---

## 11. Known edge cases & gotchas

Ranked by engagement-hours-lost. Top four are all `[FIELD-CONFIRMED]`.

### 11.1 Case-sensitivity + Unicode in userName matching `[COSTS HOURS]`

Dedup missed or PATCH 404s because `userName` comparison is case-sensitive by default (per OIN test suite step 16), but many customer source systems are case-insensitive. NFC vs NFD Unicode normalization silently breaks matches when user names contain accented characters. Resolution: §2 normalization policy.

### 11.2 Reactivation with stale attributes `[COSTS HOURS]`

Soft-delete + attribute zeroing + reactivation = user returns with an empty profile. Customer app breaks assuming profile is valid. Resolution: §4 + §6 reactivation flow.

### 11.3 Group push race conditions `[COSTS HOURS]`

Concurrent add/remove on the same member; add to a deleted user; add to a non-existent group. Resolution: §5 idempotency + clean error returns.

### 11.4 PATCH ordering / sequencing `[COSTS HOURS]`

Multi-op PATCHes applied in parallel or reordered by the server corrupt state. Resolution: §1 sequential atomic application per RFC 7644 §3.5.2.

### 11.5 Closed by Okta docs (SILVER LAW pass, 2026-05-04)

These items were in v1's [OPEN] list but are now closed by the protocol reference ([/docs/api/openapi/okta-scim/guides/scim-20/](https://developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20/)):

- **Multi-op PATCH** → supported (see §1). Server MUST handle.
- **Default pagination** → `count: 100`, `startIndex: 1`, integers (see §7).
- **Filter operators Okta commits to** → only `eq` explicitly (see §2). Everything else is field-observed but NOT a doc-guaranteed emission.
- **`externalId` semantics** → per the protocol reference, `externalId` contains **the SCIM server's unique identifier for the resource, stored in Okta's user profile**. It is NOT Okta's user ID; it is YOUR server's ID persisted on Okta's side for cross-system correlation. This is important: if your server reassigns IDs on reactivation or migration, Okta's `externalId` drifts and dedup breaks.

### 11.6 `[OPEN — genuinely doc-silent, tribal-knowledge or fixture-bound]`

These remain unknown after a full Okta-docs sweep. Okta's protocol reference + concepts + prepare/test/connect guides do NOT specify any of these. Closing them requires either a past-engagement memory, a real-payload fixture, or an Okta support ticket.

- **Timestamp format in `meta.lastModified`** — RFC 7643 says `xsd:dateTime` (ISO 8601) but Okta doesn't specify fractional-seconds, offset vs `Z`, or timezone-suffix behavior. Default conservatively: emit `YYYY-MM-DDTHH:mm:ssZ` (no fractions, UTC Z).
- **Large-attribute handling** — profile photos (base64 inline?), long biographies, oversized group member lists. No documented request-size cap. Operational concern, not protocol.
- **Schema extension custom attributes Okta populates** — protocol ref shows `urn:ietf:params:scim:schemas:core:2.0:User` only. Which `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User` fields (employeeNumber, department, manager, costCenter, organization, division) Okta actually sends in practice, and whether customers configure their own namespaces beyond enterprise — undocumented. Admin-configurable per Okta app setup, not a protocol-level fact.
- **PATCH retry idempotency** — if Okta retries a PATCH that actually succeeded server-side, does the server's second-call handling stay correct? No Okta guarantee documented. Server should be idempotent-by-design (consumed-on-first-use patterns on stateful ops).
- **Multi-value `primary` flag behavior** — structure documented (`emails[primary eq true]`), semantics (what happens when you PATCH primary from email A to email B — does A demote? does B promote?) not documented. Field-bound.
- **Reserved attribute name collisions** — design-level question. No Okta guidance. Resolve per-customer by namespacing custom fields into a schema extension URN rather than the core namespace.
- **Error `detail` field localization / customer UI leakage** — Okta surfaces `detail` directly in some admin UIs; no doc on safe-content policy. Treat `detail` as customer-facing copy; never include PII or internal stack traces.

---

## 12. Appendix: Okta's 13 OIN-gating tests

The authoritative acceptance gate for OIN-listed SCIM servers. Source: [Okta-SCIM-20-SPEC-Test.json](https://developer.okta.com/standards/SCIM/SCIMFiles/Okta-SCIM-20-SPEC-Test.json). A server that passes these 13 tests is accepted into OIN; one that doesn't, is not.

| # | Category | Test | What it checks |
|---|----------|------|----------------|
| 0 | Required | Test Users endpoint | `GET /Users?count=1&startIndex=1` returns a valid ListResponse |
| 2 | Required | Get `/Users/{id}` | Read by ID returns the user |
| 4 | Required | Invalid User by username | `GET /Users?filter=userName eq "<invalid>"` returns empty ListResponse (NOT 404) |
| 6 | Required | Invalid User by ID | `GET /Users/<nonexistent>` returns 404 |
| 8 | Required | Random user doesn't exist | Same as step 4 with a different username |
| 10 | Required | Create Okta user | `POST /Users` with realistic values returns 201 + body |
| 12 | Required | Verify user was created | Follow-up `GET /Users/{newId}` returns the created user |
| 14 | Required | Duplicate create fails | Re-POST same user returns 409 + `scimType: "uniqueness"` |
| 16 | Required | **Username case sensitivity** | Case-varied filter returns DIFFERENT result (asserts case-sensitive match) |
| 18 | Optional | Groups endpoint | `GET /Groups` returns a ListResponse (skipped for user-only apps) |
| 20 | Required | Status 401 on no/bad auth | Missing or invalid bearer rejected with 401 |
| 22 | Required | Status 404 on unknown user ID | Non-existent ID returns 404 |

**The replay-test runner's highest-value fixtures directly mirror these steps.** Day 2 synthetic fixtures already cover: user-create (step 10), user-filter-username (step 4/8), user-patch-deactivate (post-OIN lifecycle). Day 5 real captures will add group push, case-sensitivity check, auth failure, duplicate-create uniqueness — bringing fixture coverage to full OIN parity.

---

## How to annotate this doc going forward

1. Every new fixture captured in `fixtures/okta-payloads/` gets a cross-reference added to the relevant section here — the claim gets cited with the fixture path, upgrading `[UNVERIFIED]` to `[FIELD-CONFIRMED with fixture]`.
2. Every new Okta behavior observed that isn't already captured → add a subsection in §11.
3. Every contradiction between Okta docs and observed behavior → flag with `[OKTA DOCS SAY X BUT OBSERVED Y]` and escalate to Okta support for clarification.
4. Commits should follow the pattern `docs(dialect): §N <specific update> (+ fixture-ref or doc-url)` so the history shows what-we-know over time.
