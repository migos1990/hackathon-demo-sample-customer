# scimmy (subset) — Integration Doc

**Purpose:** SCIM 2.0 type definitions, schema envelopes, and message (ListResponse, Error, PatchOp) shapes as TypeScript. **We use only a subset** — specifically `SCIMMY.Schemas`, `SCIMMY.Messages`, `SCIMMY.Types`. We do NOT use `SCIMMY.Resources` (its handler framework conflicts with our customer-attribute-mapping layer).

**Version:** `^1.3.5` (pinned). Latest 2025-03-05. 546 commits, 15 releases.
**License:** MIT.
**Homepage:** <https://github.com/scimmyjs/scimmy>

## How we use it

```typescript
// Static schema returns for /Schemas, /ResourceTypes, /ServiceProviderConfig
import SCIMMY from "scimmy";
const userSchema = SCIMMY.Schemas.User.definition;
const groupSchema = SCIMMY.Schemas.Group.definition;

// Message envelopes for list responses and errors
const response = new SCIMMY.Messages.ListResponse(resources, { totalResults, startIndex, itemsPerPage });
const error = new SCIMMY.Messages.Error(new Error("invalid"), 400, "invalidFilter");
```

## What we DO NOT use

- **`SCIMMY.Resources`** — its ingress/egress/degress handler framework makes opinionated assumptions about resource lifecycle. Our generated servers need flexibility around customer-specific attribute mapping and the three lifecycle policies (hard_delete / soft_delete / archive) from the ticket template. We route through our own handlers and only use SCIMMY's types/messages.
- **`scimmy-routers`** — the companion Express middleware. We hand-roll ~40 lines of routing that's easier to customize.

## The Okta divergence risk

SCIMMY's README states: *"SCIMMY has been tested against Microsoft Entra ID (formerly Azure AD)"* — **NOT** against Okta. Our risk: SCIMMY's envelope shapes or schema representations might diverge from what Okta expects. Mitigation: the replay-test suite against `fixtures/okta-payloads/` catches any drift. Any Okta-specific behavior that SCIMMY gets wrong, we override at our boundary (not by patching SCIMMY).

## Env vars / secrets

None.

## Post-deploy verification checklist

- [ ] `GET /scim/v2/ServiceProviderConfig` returns a valid envelope per RFC 7644 §4
- [ ] `GET /scim/v2/Schemas` returns the User and Group schemas
- [ ] `GET /scim/v2/Users` returns a `ListResponse` with correct `totalResults` / `startIndex` / `itemsPerPage`
- [ ] Error responses use `Messages.Error` envelope per RFC 7644 §3.12

## Runbook

- **SCIMMY throws on schema instantiation** → library expects specific User/Group shapes; if our customer mapping produces unexpected fields, override by constructing the resource manually before passing to `Messages.ListResponse`.
- **Schema output differs from Okta's test suite expectation** → override at our route handler; don't patch SCIMMY. Add a `[FIELD-CONFIRMED]` note to `okta-dialect.md` §10.
