# Scripts

Utility scripts for harness maintenance. All TypeScript; run via `npx tsx <script>.ts`.

## `sanitize-payload.ts`

Redacts PII from raw Okta SCIM captures into fixture-safe text.

### What it redacts

| Pattern | Replaced with | Deterministic across a single invocation? |
|---------|---------------|-------------------------------------------|
| `*@<domain>` emails | `user-001@example.com`, `user-002@example.com`, ... | Yes (same input → same placeholder) |
| `https://*.okta.com` / `https://*.oktapreview.com` | `https://demo-customer-a.oktapreview.com` | Yes |
| `00u<17-22 chars>` (Okta user IDs) | `00u00000000000000001`, ... | Yes |
| `00g<17-22 chars>` (Okta group IDs) | `00g00000000000000001`, ... | Yes |
| UUIDs (RFC 4122) | `00000000-0000-0000-0000-000000000001`, ... | Yes |

### What it does NOT redact (redact manually)

- Bearer tokens / auth header values (format too free to regex safely — risk of over-match)
- Customer-specific phone numbers (locale variability)
- Free-text fields: `title`, `department`, `description`, `displayName` if it contains customer-internal jargon
- Customer company names embedded in group names (e.g. `acme-engineering` → manually map to `demo-group-engineering`)

### Usage

```bash
# From stdin
cat raw-capture.http | npx tsx scripts/sanitize-payload.ts > fixtures/okta-payloads/<scenario>/request.http

# From a file
npx tsx scripts/sanitize-payload.ts raw-capture.http > fixtures/okta-payloads/<scenario>/request.http

# The substitution map prints to stderr for manual audit:
npx tsx scripts/sanitize-payload.ts raw-capture.http 2> substitution-audit.json
```

### Review before commit

1. `diff` the pre- and post-sanitize output; confirm every real PII shape got replaced
2. Read `substitution-audit.json` (stderr output) — confirm the original values make sense
3. Manually redact anything the tool missed (see "does NOT redact" list)
4. Commit the fixture + the `notes.md` explaining provenance

### Integrity properties (per TRUTH LAW — tested)

- Same input on two calls → same output (deterministic within a call; see `sanitize-payload.test.ts`)
- Already-redacted input is idempotent (`user@example.com` and `https://demo-customer-a.oktapreview.com` pass through unchanged)
- No external network calls; pure string transform

### Adding a new pattern

1. Write the test first in `sanitize-payload.test.ts` (IRON LAW)
2. Extract a spec constant at the top of `sanitize-payload.ts` for the target format
3. Export a `<thing>Placeholder(n)` function so the test can assert against it
4. Add the regex + replacement branch inside `sanitize(...)`
5. Run `npm test` — observe green before committing

## When to add scripts here

- Build / maintain a harness artifact (fixture prep, schema validation, replay setup)
- Run against captured data (sanitize, normalize, re-validate)
- Do not put production server code here — that belongs in `skeleton/` or `validators/`
