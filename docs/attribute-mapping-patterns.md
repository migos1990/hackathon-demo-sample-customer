# Attribute Mapping Pattern Library

**Status:** v0.5 — Pattern 1 (LDAP) filled with a worked example + fixtures + edge cases via the `connectors/acme-hr/` reference connector. Patterns 2 (Workday) and 3 (Custom-DB) still skeleton-only; Day 7 completes them.

**Purpose:** each pattern documents a common source-schema shape and how to map it cleanly to SCIM 2.0 core + enterprise extension. The agent picks the closest pattern to the customer's `user_model` field in the ticket template and adapts.

## Pattern index

| # | Source shape | When to use | Status |
|---|--------------|-------------|--------|
| 1 | LDAP-shaped (`dn`, `cn`, `sn`, `mail`, `memberOf`) | Customer exposes a user directory or LDAP-style API | ✅ Filled — [`patterns/01-ldap.md`](patterns/01-ldap.md) |
| 2 | Workday-shaped (`Worker_ID`, `Work_Email`, `Legal_Name/First`, `Legal_Name/Last`, `Primary_Work_Location`) | Customer sources users from a HRIS with Workday-family shape | Skeleton only |
| 3 | Custom-DB-shaped (arbitrary source schema) | Everything else; agent emits a bespoke mapping config | Skeleton only (stretch on Day 7) |

Each pattern's dedicated file (to land on Day 7):

- `patterns/01-ldap.md`
- `patterns/02-workday.md`
- `patterns/03-custom-db.md`

Each file contains:

1. **Source-schema shape** — sample `GET /users` response from the source
2. **SCIM target shape** — what the SCIM server returns to Okta
3. **Mapping config** — YAML/JSON the generated server reads at boot
4. **Transformation notes** — type coercion, null handling, multi-value splits
5. **Edge cases** — name joins, email format quirks, missing required fields
6. **Test fixture** — a paired source-input → expected-SCIM-output fixture the replay rig can exercise

## Mapping config format (stable contract)

Every generated server reads a mapping config at boot. This is the contract:

```yaml
# mapping.yaml — per-customer attribute mapping
version: 1
source:
  system: ldap   # ldap | workday | custom
  base_url: ${SOURCE_API_BASE_URL}
  auth:
    kind: bearer # bearer | basic | oauth
    credential_env: SOURCE_API_TOKEN

users:
  source_endpoint: "/users"
  source_id: "dn"                      # field that uniquely identifies a user in the source
  scim_id: "id"                        # SCIM's resource id; server generates if not passed through

  # one-to-one field mappings
  fields:
    userName:
      source: "mail"                   # dotted path or direct field
      transform: "lowercase"           # optional: lowercase | uppercase | trim | split:<delim> | join:<delim>
    name.givenName:
      source: "cn"
      transform: "split_name:first"
    name.familyName:
      source: "sn"
    active:
      source: "enabled"
      transform: "coerce_bool"
    emails:
      kind: multi_value
      source: "mail"                   # string source → single-element multi-value
      wrap:
        type: "work"
        primary: true
    enterprise.employeeNumber:
      source: "employeeId"
      schema_extension: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"

groups:
  source_endpoint: "/groups"
  source_id: "dn"
  fields:
    displayName:
      source: "cn"
    members:
      kind: multi_value_lookup
      source: "member"                 # list of source user IDs (dn strings)
      transform: "resolve_to_scim_id"
```

**Why this contract matters:** the agent can generate a SCIM server AND a mapping config separately. Changing a customer's attribute mapping later = edit the YAML, don't regenerate code. Keeps the generated server reusable across customers.

## Validation

The `validators/` directory gets a `mapping-config-validator.ts` on Day 8. It enforces:

- Every SCIM field that's `required` per RFC 7643 has a source mapping
- `schema_extension` URNs are well-formed
- `transform` functions exist in the skeleton's transform registry
- No source field is mapped to two SCIM fields (unless explicitly flagged)

## Transform registry

Generated servers import a transform registry. Adding custom transforms = PR against the harness, not against the generated code.

Baseline transforms (implement in the skeleton on Day 3):

| Name | Input | Output |
|------|-------|--------|
| `lowercase` / `uppercase` / `trim` | string | string |
| `split:<delim>` | string | string[] |
| `join:<delim>` | string[] | string |
| `coerce_bool` | string/number/bool | bool |
| `split_name:first` / `split_name:last` | "First Last" | "First" or "Last" |
| `resolve_to_scim_id` | source user ID | SCIM ID (via lookup table) |
| `format_date:iso8601` | any date-like | ISO 8601 UTC |
| `default:<value>` | anything (used when source is null) | the default |

Add custom transforms on Day 7 as each pattern demands them.

---

**Day 7 fill: complete patterns 1-3 with worked examples, fixtures, and notes.**
