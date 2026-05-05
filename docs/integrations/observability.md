# Integration: Observability

**Law:** PROD-READINESS (14) covers every external integration; OBSERVABLE (Connector Law 8) covers what every generated connector exposes. This doc ties them together for the observability surface that lives inside `skeleton/`.

**Scope:** three primitives — structured JSON logger, request-id correlation middleware, `/healthz` liveness + target-reachability probe. All live in `skeleton/` so every generated connector inherits them by default.

---

## What every generated connector exposes

### 1. `/scim/v2/healthz`

Auth-exempt liveness endpoint. Returns:

| Scenario | Status | Body |
|---|---|---|
| Connector up, no `store.ping()` | 200 | `{ status: "ok", uptime_seconds, version }` |
| Connector up, `store.ping()` resolves | 200 | `{ status: "ok", uptime_seconds, version, target_reachable: true }` |
| Connector up, `store.ping()` rejects | 503 | `{ status: "degraded", uptime_seconds, version, target_reachable: false, target_error: "..." }` |

**For load balancers / k8s:** treat 503 as unhealthy — route traffic away. 200 is healthy even if target is unreachable (unless you want 503-triggered failover on target loss; most Okta deployments don't, because a degraded connector that's up can still serve GET requests and metadata probes).

**For uptime pings:** hit `/scim/v2/healthz` every 30-60 seconds. Alert on 503 > 2 consecutive failures.

### 2. Request-ID correlation

Every request gets a correlation id via `skeleton/middleware/request-id.ts`:

- If the caller sends `X-Request-Id` AND it's safe (≤128 chars, only `[A-Za-z0-9._-]`), preserve it. This enables end-to-end correlation through Okta's retry logic.
- Otherwise generate a fresh 16-hex-char id (64 bits of entropy).
- Available downstream as `res.locals.request_id`.
- Echoed back as `X-Request-Id` response header.

**Why the safety regex matters:** unsafe characters — especially newlines — enable log-forging attacks (an attacker injects `\nfake log line` into their id, it gets concatenated into a log, now there's a fabricated log entry). The regex rejects the attack, regenerates.

### 3. Structured JSON logger

`skeleton/logger.ts` exports `createLogger(opts)`. Every log line is a single JSON object on one line — friendly for `jq`, CloudWatch Insights, Loki, etc.

Shape:
```json
{ "ts": "2026-05-05T14:00:00.000Z", "level": "info", "msg": "request_completed",
  "request_id": "a1b2c3d4e5f60718", "method": "POST", "path": "/scim/v2/Users",
  "status": 201, "duration_ms": 42 }
```

Level gates (default `info`): `debug < info < warn < error < silent`. Set via `level` option.

**Secret hygiene:** `authorization`, `cookie`, `set-cookie`, `proxy-authorization` header values are automatically redacted to `[REDACTED]` case-insensitively, anywhere in the logged field tree. A bearer token leaking into logs is a Common Criteria evaluation failure — this is defense in depth.

**Circular reference safety:** `redact()` walks objects with a `WeakSet` to avoid infinite recursion. Cyclic structures serialize to `"[Circular]"` instead of crashing the logger.

**Error serialization:** `Error` instances serialize to `{ name, message, stack }` — otherwise `JSON.stringify` produces `{}` for errors and you lose the signal.

### Composition: `log.child({ request_id })`

Per-request logging is a `child()` call in middleware:

```ts
app.use((req, res, next) => {
  (res.locals as any).log = baseLog.child({ request_id: (res.locals as any).request_id });
  next();
});
```

Every downstream `res.locals.log.info(...)` call inherits the request_id automatically.

---

## What this doc does NOT cover

- **Log shipping.** Harness emits structured JSON to stdout/stderr. How you forward those bytes to a log aggregator is deployment-specific.
- **Metrics (Prometheus / OpenTelemetry).** Out of scope for the Hackathon build. Future work would add a `/metrics` endpoint and instrument the SCIM routes with counter + histogram emission.
- **Distributed tracing.** `X-Request-Id` + `traceparent` propagation would be the starting point. Not wired.
- **Sampling.** The logger emits every line. High-volume prod deployments would need sampling at the shipping layer.

---

## Post-deploy verification checklist

- [ ] `curl $URL/scim/v2/healthz` returns 200 with `status: "ok"` when target is reachable
- [ ] Kill the target, re-curl — 503 with `target_error` detail
- [ ] Send a request with `-H "x-request-id: my-id-123"` — response `x-request-id` header echoes `my-id-123`
- [ ] Send a request with NO request-id header — response has a fresh 16-hex-char id
- [ ] Send a request with a malicious id (`-H "x-request-id: $(printf 'bad\\nforged')"`) — server rejects (Node refuses to transmit the bad header) OR regenerates; never echoes the bad bytes
- [ ] stdout/stderr log lines are single-line JSON with `ts`, `level`, `msg` fields; parse with `jq` successfully
- [ ] No Authorization bearer token value appears in the logs — search with `grep 'Bearer [A-Za-z0-9]' <log>` should return nothing (all `authorization` values are `[REDACTED]`)

---

## Last updated
2026-05-05 — initial integration doc alongside the commits that landed `/healthz`, request-id middleware, and structured logger.
