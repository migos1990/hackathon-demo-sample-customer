# scim2-parse-filter — Integration Doc

**Purpose:** parse SCIM 2.0 filter expressions per RFC 7644 §3.4.2.2 — the grammar behind `GET /Users?filter=userName eq "x"`. Produces an AST we can evaluate against an in-memory data set.

**Version:** `^0.3.0` (pinned). Fork of nazoking/scim2-filter v0.2.0 with bug fixes. Latest 2026-03-18.
**License:** MIT.
**Homepage:** <https://github.com/thomaspoignant/scim2-parse-filter>

## How we use it

In `skeleton/routes/users.ts`'s LIST handler:

```typescript
import { parse, filter } from "scim2-parse-filter";

// Parse the query string's filter param; filter() evaluates AST against a resource
const ast = parse(req.query.filter as string); // throws on invalid syntax
const matched = allUsers.filter((user) => filter(user, ast));
```

**Okta-dialect overlay:** case-sensitivity policy from the customer's ticket template overrides the default. Wrap the `filter()` call with a normalizer that NFC-normalizes and lowercases userName attributes ONLY if the customer's `userName_match_policy === "case_insensitive"`. See `okta-dialect.md` §2.

## Env vars / secrets

None.

## Post-deploy verification checklist

- [ ] Replay fixture `fixtures/okta-payloads/user-filter-username/` passes — `userName eq "..."` returns a ListResponse with exactly one match
- [ ] Parser rejects malformed filters with `400 Bad Request` + `scimType: "invalidFilter"` per RFC 7644 §3.12
- [ ] Case-sensitivity behavior matches the customer's ticket-template policy — both policies have test coverage

## Known limitations

- Only supports operators defined by RFC 7644 (`eq`, `ne`, `co`, `sw`, `ew`, `gt`, `ge`, `lt`, `le`, `pr`). No `in`/`nin` extensions. (Per `okta-dialect.md` §2, Okta's protocol reference only commits to `eq` anyway, so this is fine.)
- Returns throwing on parse errors; wrap in try/catch in route handlers to map to proper SCIM error envelope.

## Runbook

- **Filter returns 500 with parse error** → malformed filter, should have been 400. Check the wrapping error-map middleware.
- **Filter returns 200 with unexpected results** → case-sensitivity mismatch. Compare customer ticket template's policy vs. runtime behavior.

## Risk + mitigation

| Risk | Mitigation |
|------|-----------|
| Parser correctness on complex-attribute filters (`emails[type eq "work"].value`) | Replay fixtures cover this shape; any regression surfaces immediately. |
| Custom attribute filter (schema extensions) | Feature-check before assuming support; fall back to unfiltered list if parser rejects. |
