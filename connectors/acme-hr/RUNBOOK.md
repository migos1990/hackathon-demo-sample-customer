# RUNBOOK — AcmeHR SCIM Connector

The reference connector for the demo. Fills every section of
`ticket-templates/runbook-template.md` with real, tested content — this
is what a generated connector runbook should look like for any
customer app.

## Environment variables

| Var | Purpose | Required? | Format |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector | Yes in prod, optional in dev | ≥32 chars |
| `ACME_HR_API_TOKEN` | Bearer token this connector presents to AcmeHR-lite's API | Yes in prod, optional in dev | ≥32 chars |
| `ACME_HR_BASE_URL` | AcmeHR API endpoint | No (defaults to `http://localhost:4001`) | https:// URL |
| `CONNECTOR_PORT` | Listen port | No (defaults to 3002) | integer |
| `PROMOTION_SIGNING_KEY_CURRENT` | HMAC key for Promotion Manifest signing | Yes on sign/verify | ≥32 chars |
| `PROMOTION_SIGNING_KEY_CURRENT_ID` | Human-readable key id stamped into envelope | No (defaults to `current`) | short string |

In dev, omit `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` — the skeleton and the AcmeHR-lite target both pass-through when unset. Never ship a prod deploy without both tokens set.

## Deployment

Prerequisites:
- Node 20+, `npm ci` completed.
- AcmeHR-lite target reachable at `ACME_HR_BASE_URL`.
- For demo: both apps run on the same host, ports 3002 (connector) and 4001 (target).

Start the stack:
```bash
# Terminal 1
npm run start:acme-hr
# Logs: "listening on http://localhost:4001"

# Terminal 2
npm run start:acme-hr-connector
# Logs: "SCIM server on http://localhost:3002/scim/v2"
```

Verify the connector reaches Okta-native payloads:
```bash
curl -sS -X POST http://localhost:3002/scim/v2/Users \
  -H "Content-Type: application/scim+json" \
  -d '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"test","emails":[{"value":"t@example.com","primary":true}],"active":true}'
# Expected: 201 + body with uid=test
```

For production deploy (Terraform — not yet wired in this repo, Day 6):
```bash
terraform workspace select <staging|prod>
terraform apply -auto-approve
```

## Rollback

If staging fails the verify gate, do NOT promote. Fix the ticket, re-generate.

If prod goes sideways after promotion:
```bash
# 1. Identify the last-known-good tag from the prior Promotion Manifest.
jq -r .manifest.git_tag last-good-manifest.json

# 2. Check out that ref.
git checkout <last-known-good-tag>

# 3. Re-apply prod (once Day 6 Terraform lands).
terraform workspace select prod
terraform apply -auto-approve

# 4. Re-run smoke to confirm.
tsx scripts/smoke/cli.ts --connector-url $PROD_CONNECTOR_URL --target-url $PROD_TARGET_URL
```

**Blast-radius note:** prod rollback requires the SAME two-of-two approval as a forward promotion per Connector Law 10 (AUDIT-TRAIL). A unilateral rollback is a security incident, not a recovery.

## Smoke + verification

Three checks, all must pass:

```bash
# 1. Health — connector is alive AND can reach its target.
curl -sS http://localhost:3002/scim/v2/healthz
# Expected (healthy): {"status":"ok","uptime_seconds":N,"version":"dev","target_reachable":true}
# Expected (degraded — target unreachable): HTTP 503 with target_error detail.

# 2. Full smoke cycle — provision, deactivate, verify target reflects the deactivation.
tsx scripts/smoke/cli.ts \
  --connector-url http://localhost:3002 \
  --target-url    http://localhost:4001
# Expected: exit 0, JSON report with smoke_test_passed=true, log_errors_count=0

# 3. Admin UI visual confirmation — demo shot 5.
open http://localhost:4001/admin
# Expected: smoke user appears with status=Deactivated after the smoke run.
```

## Known limitations

- **Groups not yet implemented.** The skeleton and connector handle Users + PATCH + filter; group-push and group_members_patch from the ticket template are future work. Enabling `required_ops.groups: true` on a ticket today will produce a connector that advertises groups in `/ServiceProviderConfig` but rejects actual group operations.
- **Observability scope is limited.** `/healthz` + structured JSON logger + request-id correlation are wired (Law 8 OBSERVABLE green). What's NOT yet here: log shipping to a central store (CloudWatch / Loki / Datadog), metric emission (Prometheus/OTel), and distributed tracing. Those are deployment-shape decisions deferred to the consumer of the harness.
- **Filter pushdown is absent.** `GET /Users?filter=...` fetches all AcmeHR users and filters in-memory. For a customer app with >10k users, this will be slow. Generated connectors for filter-capable targets should push the filter down to the target API.
- **Single-node only.** No multi-instance support. A horizontally-scaled deployment would share state via the target app, not the connector — the connector is stateless by design — but the Terraform scaffold assumes one node.
- **Demo-only auth configuration.** Bearer-token auth is implemented, but key rotation for SCIM_AUTH_TOKEN and ACME_HR_API_TOKEN is manual. Hackathon-scope.

## On-call / escalation

- **Primary contact (demo owner):** Louis Migault — Slack DM
- **Secondary (Pro Serve backup):** TBD — fill before prod customer cutover
- **P0 incident (customer prod auth broken):** PagerDuty rotation for Pro Serve once a customer takes this into prod; hackathon has no on-call rotation.
- **Hours of coverage:** Hackathon-grade coverage = best-effort during the demo weekend. Production customers require 24x7 rotation before go-live.
- **SLA targets:** None for hackathon. Production customers: P0 response within 30 minutes, P1 within 4 hours, P2 within 1 business day (target, not a commitment).
