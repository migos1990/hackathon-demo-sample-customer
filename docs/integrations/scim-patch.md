# scim-patch — Integration Doc

**Purpose:** apply RFC 7644 §3.5.2 PATCH operations (`add`, `remove`, `replace`) to SCIM resources. Handles filter-path expressions, multi-valued attributes, and atomicity.

**Version:** `^0.9.0` (pinned in `package.json`). 47 releases historically; latest 2026-03-18.
**License:** Unlicense (public domain).
**Homepage:** <https://github.com/thomaspoignant/scim-patch>

## How we use it

Wraps the PATCH handler in `skeleton/routes/users.ts` and `skeleton/routes/groups.ts`. We do NOT fork or vendor — it's a pure-function library, safe to import directly.

```typescript
import { scimPatch, patchBodyValidation } from "scim-patch";

// In the PATCH handler:
patchBodyValidation(req.body); // throws on invalid PatchOp envelope
const updated = scimPatch(currentResource, req.body.Operations, { treatMissingAsAdd: false });
```

**Options we set:**
- `treatMissingAsAdd: false` — enforces strict RFC compliance. A `replace` on a missing attribute fails rather than silently becoming an `add`. See `okta-dialect.md` §1 for why strict is the right default for us.

## Env vars / secrets

None.

## Post-deploy verification checklist

- [ ] `npm test` includes the PATCH-handler tests and they're green (IRON LAW)
- [ ] Replay suite passes fixture `fixtures/okta-payloads/user-patch-deactivate/` — active:false PATCH results in a 200 with `active: false` in the body (per `okta-dialect.md` §4)
- [ ] Multi-op PATCHes are applied atomically (all-succeed or all-reject) — covered by a dedicated test in the replay suite

## Known limitations

- No built-in logging; we wrap with our own structured-logging middleware per OBSERVABILITY LAW.
- Error messages from the library include internal state; redact via our logger before they leak to responses.

## Runbook

- **PATCH returns 500 with "invalid path"** → the filter-path parser hit an edge case. Check the operation's `path` field; add a reproduction fixture to `fixtures/okta-payloads/` if Okta sent something the library can't parse.
- **Multi-op PATCH partial-applies** → `scim-patch` should be atomic, but our wrapper must also roll back any side effects (e.g., database writes) on failure. The skeleton's handler uses a transaction around the whole call.

## Risk + mitigation

| Risk | Mitigation |
|------|-----------|
| Single-maintainer (thomaspoignant) | 47-release history + active CI signals stability. Code small enough to vendor if upstream stalls. |
| Library interprets `treatMissingAsAdd: true` by default | We override to `false`. Tests assert the strict behavior. |
| NPM supply-chain compromise | Pin exact version, commit `package-lock.json`, `npm audit` on every dep change. |
