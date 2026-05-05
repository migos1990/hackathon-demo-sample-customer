# Okta SCIM Payload Fixtures

The golden-set for the `replay-test/` runner (per **EVAL LAW**). Each subdirectory is one named scenario with three files:

```
<scenario-name>/
  request.http        # raw HTTP request (Okta → our SCIM server)
  response.http       # raw HTTP response (our SCIM server → Okta)
  notes.md            # provenance, citations, what the agent should learn
```

## Naming convention

`<resource>-<verb>-<variant>` e.g. `user-create`, `user-patch-deactivate`, `user-filter-username`, `group-add-member`.

## Provenance markers (mandatory in `notes.md`)

Every fixture declares its provenance:

- `[REAL-CAPTURE — YYYY-MM-DD]` — captured from a live Okta → real server interaction; sanitized via `scripts/sanitize-payload.ts`
- `[SYNTHETIC — derived from Okta public docs]` — manually crafted from Okta's public SCIM integration docs; cite the URL
- `[SYNTHETIC — derived from RFC 7644]` — crafted from RFC grammar only (rare; prefer Okta-sourced)

**The replay runner treats REAL-CAPTURE fixtures as authoritative.** SYNTHETIC fixtures are floor coverage until real captures replace them.

## `request.http` / `response.http` format

Standard HTTP message format — single start-line, headers, blank line, optional body. Replayable by any HTTP tool (curl, httpyac, REST Client, custom replay runner).

Request example:
```
POST https://demo-customer-a.oktapreview.com/scim/v2/Users HTTP/1.1
Content-Type: application/scim+json
Authorization: Bearer <TOKEN>

{...}
```

Response example:
```
HTTP/1.1 201 Created
Content-Type: application/scim+json

{...}
```

## Sanitization

**Never commit a fixture with real customer data.** Run `npx tsx scripts/sanitize-payload.ts <raw-capture> > fixture-file` before committing. Review the output and the substitution map (printed to stderr) by eye — the sanitizer only handles common PII shapes; free-text fields (title, department, description) need manual redaction.

## Target

- **Day 3 floor:** 5 fixtures green against the skeleton
- **Day 5 target:** 10-15 fixtures (including captures from live demo-tenant provisioning)
- **Demo-ready:** 20-30 fixtures covering the canonical Okta flows
