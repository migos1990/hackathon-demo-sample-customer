# user-patch-deactivate — notes

**Provenance:** `[SYNTHETIC — derived from Okta public docs]`
**Source:** <https://developer.okta.com/docs/guides/scim-provisioning-integration-test/main/#deactivate-a-user>
**Retrieved:** 2026-05-04

## What this fixture exercises

- `PATCH /scim/v2/Users/{id}` with a replace-operation setting `active: false`
- PatchOp schema `urn:ietf:params:scim:api:messages:2.0:PatchOp`
- Okta's preferred deactivation semantic — PATCH active false, NOT DELETE
- Server returns `200 OK` + full updated resource body (NOT `204 No Content`)

## What the generated server MUST do

- Parse the PatchOp envelope — `schemas` array is mandatory
- Apply the `replace` op targeting the unscoped `active` field
- Branch on customer's `lifecycle_policy` (per ticket template):
  - `hard_delete` → remove the user row, return 200 with `active: false` body or 204
  - `soft_delete` → mark `active: false`, retain the row, return 200
  - `archive` → move to archive storage, return 200
- Honor `deactivation_attribute_clearing` list from the ticket — clear specified attributes in the same transaction
- Return `200 OK` with the updated resource body (Okta reads the body to confirm state)
- Future PATCH operations on the same user with `active: true` MUST restore access (idempotent reactivation)

## Anti-patterns the replay test should catch

- Server returning `204 No Content` with no body — Okta prefers the body
- Server ignoring `schemas` field on PatchOp and guessing — RFC 7644 §3.5.2 requires it
- Server failing to reactivate on subsequent `active: true` PATCH
- Server cascading to group membership removal on deactivation (it should NOT — that's group-push's job, not User deactivation's)

## Related dialect doc sections

- `docs/okta-dialect.md` §1 (PATCH operation quirks — `op: replace` targeting unscoped attribute)
- `docs/okta-dialect.md` §3 (Soft vs hard delete — ticket template's `lifecycle_policy` drives server behavior)
- `docs/okta-dialect.md` §4 (`active` attribute behavior — reactivation semantics)
- `docs/okta-dialect.md` §6 (Attribute deprovisioning — `deactivation_attribute_clearing`)
