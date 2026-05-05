# Pattern 1 — LDAP-shaped source

**Status:** filled. Reference implementation at `connectors/acme-hr/` with test coverage at `connectors/acme-hr/mapping.test.ts` (23 tests) and live end-to-end at `connectors/acme-hr/e2e.test.ts` (5 tests).

**When to use:** the customer's native user API returns an LDAP-flavored shape — primary key is `uid` (not email), names are split into `givenName` / `sn`, email is `mail`, group membership is a `memberOf` array of DNs, activeness is a boolean `enabled` field.

This is the most common pattern when onboarding a customer with a legacy directory (Active Directory proxied through a REST wrapper, OpenLDAP + LDAP-to-REST shim, or an in-house HRIS that pre-dates SCIM).

---

## 1. Source-schema shape

Sample `GET /users/{uid}` response from the customer's API:

```json
{
  "uid": "jdoe",
  "cn": "Jane Doe",
  "givenName": "Jane",
  "sn": "Doe",
  "mail": "jdoe@acme-hr.example.com",
  "employeeNumber": "E-1234",
  "title": "Senior Engineer",
  "department": "R&D",
  "enabled": true,
  "memberOf": [
    "cn=engineers,ou=groups,dc=acme-hr,dc=example,dc=com",
    "cn=all-staff,ou=groups,dc=acme-hr,dc=example,dc=com"
  ],
  "lastModified": "2026-05-05T14:22:00.000Z"
}
```

**Characteristic fields:**

| Field | Type | Notes |
|---|---|---|
| `uid` | string | Primary key. Immutable. The connector uses this as the SCIM `id`. |
| `cn` | string | Common Name — "Given Family" format. Some users have single-token names (e.g., "Madonna"); the transform must handle that. |
| `givenName` | string | First name. May be empty for single-token names. |
| `sn` | string \| null | Surname. **Can be null** for single-token names. The SCIM mapping omits `name.familyName` entirely rather than emitting `null`. |
| `mail` | string | Primary email. Assumed to be canonical + case-preserved. |
| `employeeNumber` | string \| null | Optional HR ID. Maps to enterprise extension. |
| `title`, `department` | string \| null | Optional. Map to enterprise extension when present. |
| `enabled` | boolean | Lifecycle flag. Deactivation flips this to `false`; user row is never deleted (retention requirements). |
| `memberOf` | string[] | Group DNs. Empty array when user is in no groups. |
| `lastModified` | ISO-8601 string | Server-stamped on every mutation. |

---

## 2. SCIM target shape

Corresponding SCIM 2.0 User (output of `acmeHrToScim()` in `connectors/acme-hr/mapping.ts`):

```json
{
  "schemas": [
    "urn:ietf:params:scim:schemas:core:2.0:User",
    "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"
  ],
  "id": "jdoe",
  "userName": "jdoe",
  "name": {
    "givenName": "Jane",
    "familyName": "Doe",
    "formatted": "Jane Doe"
  },
  "emails": [
    { "value": "jdoe@acme-hr.example.com", "primary": true, "type": "work" }
  ],
  "active": true,
  "meta": {
    "resourceType": "User",
    "lastModified": "2026-05-05T14:22:00.000Z",
    "created": "2026-05-05T14:22:00.000Z"
  },
  "extensions": {
    "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": {
      "employeeNumber": "E-1234",
      "department": "R&D",
      "title": "Senior Engineer"
    }
  }
}
```

**Mapping decisions locked in:**

- **`uid` doubles as both SCIM `id` AND `userName`.** Standard LDAP-backed SCIM convention. Saves the connector from maintaining a separate id lookup table and keeps round-trips (list → filter by userName → get by id) stable.
- **`cn` → `name.formatted`.** If `cn` is absent, compose from `givenName` + `sn` at mapping time.
- **Primary email wrapping.** `mail` is a single scalar in LDAP; SCIM multi-value requires an array with `primary: true, type: "work"`. Generate the wrapping — don't expose the connector to downstream ambiguity.
- **Enterprise extension only when at least one field is non-null.** If all three of `employeeNumber`, `department`, `title` are null, omit the extension URN from `schemas` and the `extensions` object entirely. Avoids leaking empty objects to Okta.
- **`lastModified` doubles as `meta.created`.** Customer's API doesn't expose a separate creation timestamp. Approximate rather than invent. Generated connectors for customers that DO have `createdAt` should map it directly.

---

## 3. Mapping config

Following the contract in `docs/attribute-mapping-patterns.md` §"Mapping config format":

```yaml
version: 1
source:
  system: ldap
  base_url: ${ACME_HR_BASE_URL}
  auth:
    kind: bearer
    credential_env: ACME_HR_API_TOKEN

users:
  source_endpoint: "/users"
  source_id: "uid"
  scim_id: "uid"                        # passthrough — LDAP convention

  fields:
    userName:
      source: "uid"

    name.givenName:
      source: "givenName"

    name.familyName:
      source: "sn"
      # Nullable — omit SCIM field when source is null (Madonna case).
      transform: "omit_if_null"

    name.formatted:
      source: "cn"
      fallback: "compose_name"          # {givenName} {familyName} when cn is absent

    emails:
      kind: multi_value
      source: "mail"
      wrap:
        type: "work"
        primary: true

    active:
      source: "enabled"
      transform: "coerce_bool"

    enterprise.employeeNumber:
      source: "employeeNumber"
      schema_extension: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"
      transform: "omit_if_null"

    enterprise.department:
      source: "department"
      schema_extension: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"
      transform: "omit_if_null"

    enterprise.title:
      source: "title"
      schema_extension: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"
      transform: "omit_if_null"

  meta:
    lastModified:
      source: "lastModified"
    created:
      source: "lastModified"            # approximate — no separate createdAt in source
```

The reference connector at `connectors/acme-hr/mapping.ts` is the concrete TypeScript realization of this config. For new customer connectors, the agent generates a config like this and imports the harness's transform registry — it does NOT regenerate the transform functions themselves.

---

## 4. Transformation notes

### Single-token name handling (Madonna case)

When `sn` is `null` — the user has only one name token — the SCIM mapping:

- **Omits `name.familyName`** entirely rather than emitting `null`. Okta consumers are not required to handle null family names and some reject.
- **`name.formatted`** becomes just the `givenName` with no trailing space.
- **`cn` in the source** is typically the single token ("Madonna"), not "Madonna null" — so the default `cn → name.formatted` pass-through works.

Tested: `connectors/acme-hr/mapping.test.ts:70-79` (scim→acme) and `:155-160` (acme→scim).

### Primary-email selection

LDAP sources that return multiple emails in the wire format (some ship this as a comma-separated string or a bracketed array) need a transform step to pick the primary.

For AcmeHR-lite the `mail` field is scalar, so the transform is trivial: wrap in `[{value, primary: true, type: "work"}]`. For customers with multi-email LDAP attributes, add a `split:;` transform to produce an array, then label the first as primary.

### Enterprise extension, conditional

The mapping config says "include enterprise schema URN only if at least one enterprise field is non-null." The reference implementation is at `connectors/acme-hr/mapping.ts:89-102` — it inspects the three candidate fields before deciding whether to push the extension URN into `schemas[]`.

Alternative is to always include the schema URN with an empty object — reject for two reasons: (1) it's a lie about what the resource has; (2) some Okta attribute mappings fail to match on empty extensions.

### PATCH translation (deactivation flow)

The inverse mapping (SCIM PATCH → AcmeHR native patch) handles the OIN-gating subset per `connectors/acme-hr/mapping.ts:148-201`:

- Root-level `{op: "replace", value: {active: false}}` → `{enabled: false}` (the deactivation flow, OIN SPEC step 7)
- Path-based `{op: "replace", path: "active", value: false}` → same
- Path-based `{op: "replace", path: "name.givenName", value: "Janet"}` → `{givenName: "Janet"}`
- Path-based `{op: "replace", path: "name.familyName", value: "Smith"}` → `{sn: "Smith"}`
- Unsupported path → silent no-op (do NOT throw — RFC 7644 §3.5.2 atomicity of a multi-op PATCH means a single unknown path shouldn't abort the whole operation).

---

## 5. Edge cases

| Edge case | How the pattern handles it |
|---|---|
| `sn` is null (single-token name) | Omit `name.familyName`; compose `formatted` from givenName only. |
| `cn` is missing | Fall back to `${givenName} ${familyName}` composition; trim trailing whitespace if familyName is null. |
| `mail` is missing | Reject the mapping at create time (AcmeHR requires mail; mapping throws). Tested in `mapping.test.ts`. |
| `enabled` is missing from source | Default to `active: true` per RFC 7643 §4.1.1 (active is optional in SCIM; absence means active). |
| `employeeNumber` / `department` / `title` all null | Omit the enterprise extension entirely. `schemas[]` does NOT include the enterprise URN. |
| Duplicate `uid` on create | Target returns 409; connector catches AcmeHrApiError(409), throws `UserNameConflictError`; SCIM route maps to 409 + `scimType: "uniqueness"` per RFC 7644 §3.12. |
| PATCH on nonexistent uid | Target returns 404; connector's `client.patchUser` returns `null`; store's `patch()` returns `null`; SCIM route maps to 404 + SCIM Error envelope. |
| Case-sensitive userName filter | Preserved — `connectors/acme-hr/store.ts:62-74` overrides scim2-parse-filter's default case-insensitive semantics for the `userName eq <literal>` pattern per OIN SPEC step 16. |

---

## 6. Test fixture

The replay-test rig at `replay-test/replay.test.ts` exercises the full SCIM surface against a skeleton instance seeded with an LDAP-pattern user. The fixtures that drive it live under `fixtures/okta-payloads/` (user-create, user-filter-username, user-patch-deactivate).

For a brand-new LDAP-pattern customer, duplicate the AcmeHR fixtures, change `userName` / `customer_slug`, re-run. If the replay-test rig stays green, the generated connector's attribute mapping is wire-compatible with Okta's expectations.

---

## Trust chain for this pattern

The connector-laws in `docs/connector-laws.md` all apply to AcmeHR specifically:

- **Law 1 TEST-GREEN** — 72 tests for mapping + client + store + e2e.
- **Law 2 OIN-12/12** — replay-test rig covers equivalent SPEC Test flows.
- **Law 3 DIALECT-CITED** — `connectors/acme-hr/store.ts` cites `okta-dialect.md §2` and RFC 7644 §3.5.2 inline.
- **Law 6 SMOKE-GREEN** — `runSmoke` runs end-to-end, with target-verify-deactivated step catching connector lies.
- **Law 8 OBSERVABLE** — `/healthz` probes via `AcmeHrUserStore.ping()` → `client.listUsers()`.
- **Law 9 RUNBOOK-COMPLETE** — `connectors/acme-hr/RUNBOOK.md` covers all six required sections.
- **Law 10 AUDIT-TRAIL** — signed Promotion Manifest pins the git commit that produced this pattern's connector output.

When an agent generates an LDAP-pattern connector for a NEW customer, those same laws fire — not because the agent tried harder, but because the harness gates refuse anything that doesn't satisfy them.
