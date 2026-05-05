# express — Integration Doc

**Purpose:** HTTP server and routing framework. Everything running at `/scim/v2/*` is an Express route.

**Version:** `^4.19.0` (pinned). Express 4 is still the dominant production version; Express 5 is newer but had breaking middleware changes we avoid.
**License:** MIT.
**Homepage:** <https://expressjs.com/>

## How we use it

- `skeleton/server.ts` — Express app with JSON body parsing, structured-logging middleware (per OBSERVABILITY LAW), auth middleware (per §9 of `okta-dialect.md`), error-map middleware (RFC 7644 §3.12 envelope).
- Per-route files under `skeleton/routes/` — `users.ts`, `groups.ts`, `meta.ts` (ServiceProviderConfig + Schemas + ResourceTypes).

## Design constraints

- **No route without auth** — every data route goes through the auth middleware. Metadata routes (`/ServiceProviderConfig`, `/Schemas`, `/ResourceTypes`) may be open but default to requiring auth. Enforced at the Express router level, not per-handler.
- **JSON body parser accepts both `application/json` and `application/scim+json`** — Okta's test suite uses `application/json` on POST bodies and `application/scim+json` on GET requests (per `okta-dialect.md` §10). Configure `express.json({ type: ['application/json', 'application/scim+json'] })`.
- **Response Content-Type is always `application/scim+json`** — on outbound responses, per RFC 7644 §3.1.

## Env vars

| Name | Default | Purpose |
|------|---------|---------|
| `PORT` | `3000` | HTTP listen port |
| `SCIM_AUTH_TOKEN` | (none; REQUIRED) | Bearer token the server accepts on Authorization header |
| `CUSTOMER_MAPPING_CONFIG` | `./mapping.yaml` | Path to customer-specific attribute mapping config |

## Post-deploy verification checklist

- [ ] `GET /scim/v2/ServiceProviderConfig` without auth → 401 (or 200 if policy is "metadata endpoints may be open", but default is 401)
- [ ] `GET /scim/v2/Users` with missing bearer → 401 + valid Error envelope (RFC 7644 §3.12)
- [ ] `POST /scim/v2/Users` with `Content-Type: application/json` → accepted (per `okta-dialect.md` §10 Content-Type asymmetry)
- [ ] Response `Content-Type` header is `application/scim+json` on every 2xx response

## Runbook

- **`ERR_HTTP_HEADERS_SENT`** → a middleware returned a response AND called `next()`. Express strict single-response discipline; audit the middleware chain.
- **Routes match wrong prefix** → confirm `app.use("/scim/v2", ...)` mount is in place. No production routes should live outside `/scim/v2`.

## Risk + mitigation

| Risk | Mitigation |
|------|-----------|
| Express 4 end-of-life (uncertain timeline) | Migrate to Express 5 or Hono if upstream drops support. Routing code is small enough to port. |
| Middleware ordering bugs (common in Express) | Ordering is explicit in `skeleton/server.ts`: request-id → body-parse → structured-log → auth → route. Tested via supertest. |
