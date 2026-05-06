# RUNBOOK — BigCorpHR SCIM Connector

**Ticket:** OKT-7  
**Customer app:** BigCorpHR  
**SCIM version:** 2.0  
**Lifecycle policy:** `soft_delete` — users are deactivated (enabled=false), never hard-deleted  
**Groups:** not enabled (ticket `required_ops.groups: false`)  
**Target Okta tenant:** `demo-customer-a-staging.oktapreview.com`  
**Terraform workspace:** `staging`

---

## 1. Environment variables

| Variable | Purpose | Required in prod? | Format / notes |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector on every request | **Yes** | ≥ 32 random chars; rotate via secret manager, not in repo |
| `BIGCORP_HR_API_TOKEN` | Bearer token this connector presents to BigCorpHR's API | **Yes** | Issued by BigCorpHR admin; from env var `BIGCORP_HR_API_TOKEN` per ticket OKT-7 |
| `BIGCORP_HR_BASE_URL` | BigCorpHR API base URL | No — defaults to prod | `https://api.bigcorp-hr.example.com` (prod), `https://api.staging.bigcorp-hr.example.com` (staging), `https://api.dev.bigcorp-hr.example.com` (dev) |
| `CONNECTOR_PORT` | TCP port the connector listens on | No — defaults to `3002` | Integer |
| `PROMOTION_SIGNING_KEY_CURRENT` | HMAC key for Promotion Manifest signing / verification | **Yes** at sign + verify time | ≥ 32 chars; separate value per environment |
| `PROMOTION_SIGNING_KEY_CURRENT_ID` | Human-readable key ID stamped into the manifest envelope | No — defaults to `current` | Short alphanumeric string |

**Dev-mode shortcut:** omit `SCIM_AUTH_TOKEN` and `BIGCORP_HR_API_TOKEN` entirely. Both layers pass through unauthenticated. This is safe only on localhost behind a firewall. Never ship a production deploy without both tokens set.

---

## 2. Deployment

### Prerequisites

- Node.js 20+ and `npm ci` completed in repo root.
- BigCorpHR API reachable at `BIGCORP_HR_BASE_URL`.
- All required environment variables set (see §1).

### Start (local / staging)

```bash
# Set env (staging example):
export BIGCORP_HR_BASE_URL="https://api.staging.bigcorp-hr.example.com"
export BIGCORP_HR_API_TOKEN="<token-from-bigcorp-hr-admin>"
export SCIM_AUTH_TOKEN="<token-configured-in-okta-app>"
export CONNECTOR_PORT=3002

# Start the connector:
npx tsx connectors/bigcorp-hr/start.ts
# Expected log line:
# {"level":"info","msg":"BigCorpHR SCIM connector listening",
#  "url":"http://localhost:3002/scim/v2","target":"https://api.staging.bigcorp-hr.example.com",
#  "auth_configured":true}
```

### Verify the connector is up

```bash
# Health check (no auth required on /healthz):
curl -sS http://localhost:3002/scim/v2/healthz
# Expected (healthy):
# {"status":"ok","uptime_seconds":N,"version":"dev","target_reachable":true}

# Service provider config (no auth by default):
curl -sS http://localhost:3002/scim/v2/ServiceProviderConfig | jq .patch
# Expected: {"supported":true}
```

### Wire into Okta (staging tenant)

1. In the Okta admin console for `demo-customer-a-staging.oktapreview.com`, open the BigCorpHR SCIM app.
2. Set SCIM connector base URL to `https://<connector-host>/scim/v2`.
3. Set Authentication to **HTTP Header** with value `Bearer <SCIM_AUTH_TOKEN>`.
4. Click **Test Connector Configuration** — all checks should pass.
5. Enable provisioning features: **Create Users**, **Update User Attributes**, **Deactivate Users**.

### Terraform (staging workspace)

```bash
terraform workspace select staging
terraform apply -auto-approve
# Outputs connector URL, confirms target reachable.
```

---

## 3. Rollback

### Staging rollback (pre-promotion)

If the staging deploy fails the verify gate, do **not** promote. Fix the ticket, regenerate.

```bash
# Identify the last-known-good tag from the prior Promotion Manifest:
jq -r .manifest.git_tag last-good-manifest.json

# Check out that ref:
git checkout <last-known-good-tag>

# Re-apply staging:
terraform workspace select staging
terraform apply -auto-approve

# Re-run smoke to confirm:
npx tsx scripts/smoke/cli.ts \
  --connector-url https://<staging-connector-host> \
  --target-url    https://api.staging.bigcorp-hr.example.com
```

### Production rollback (post-promotion)

A production rollback requires the same two-of-two approver sign-off as a forward promotion (Connector Law 10 AUDIT-TRAIL). Unilateral rollback is a security incident.

```bash
# Same steps as staging rollback above, but:
terraform workspace select prod
```

Contact the on-call engineer and open a P0 incident ticket before touching prod (see §6 On-call).

---

## 4. Smoke test + verification

Three checks, all must pass before marking a deploy healthy:

### 4a. Health probe

```bash
curl -sS http://localhost:3002/scim/v2/healthz
# Pass condition: HTTP 200, body contains "target_reachable":true
# Fail condition: HTTP 503 or "target_reachable":false — BigCorpHR unreachable
```

### 4b. Full provisioning smoke cycle

```bash
npx tsx scripts/smoke/cli.ts \
  --connector-url http://localhost:3002 \
  --target-url    https://api.staging.bigcorp-hr.example.com
# Pass: exit 0, JSON report with smoke_test_passed=true, log_errors_count=0
# The smoke script:
#   1. POST /scim/v2/Users  → creates a test user
#   2. GET  /scim/v2/Users/:id → verifies round-trip
#   3. PATCH /scim/v2/Users/:id with active:false → deactivates
#   4. GET from BigCorpHR directly → asserts enabled=false (target-verify step)
#   5. DELETE /scim/v2/Users/:id → soft-delete (also asserts enabled=false, not row removal)
```

### 4c. OIN filter + case-sensitivity check

```bash
# Create a user first:
curl -sS -X POST http://localhost:3002/scim/v2/Users \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],
       "userName":"jdoe.bigcorp",
       "emails":[{"value":"jdoe@bigcorp-hr.example.com","primary":true}],
       "active":true}'

# Exact-case filter must return the user (OIN step 4):
curl -sS "http://localhost:3002/scim/v2/Users?filter=userName+eq+%22jdoe.bigcorp%22" \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN" | jq .totalResults
# Expected: 1

# Wrong-case filter must return 0 results (OIN step 16 — case-sensitive):
curl -sS "http://localhost:3002/scim/v2/Users?filter=userName+eq+%22JDOE.BIGCORP%22" \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN" | jq .totalResults
# Expected: 0
```

---

## 5. Known limitations

- **Groups not implemented.** Ticket OKT-7 set `required_ops.groups: false`. If BigCorpHR group push is required in future, a follow-up ticket must add `GET /Groups`, `GET /Groups/:id`, `PATCH /Groups/:id`, and the group-push race-condition handling described in `docs/okta-dialect.md §5`.

- **Filter pushdown is absent.** `GET /Users?filter=...` fetches ALL BigCorpHR users and filters in-memory inside the connector. For tenants with large user directories (> ~5 000 users), this will be slow and memory-intensive. A future enhancement should push filter expressions down to BigCorpHR's native query API if one exists.

- **Single-node only.** The connector is stateless (all state lives in BigCorpHR), so horizontal scaling is safe in principle. However, the current Terraform scaffold provisions a single node; load-balancer wiring is deferred.

- **Reactivation attribute re-population not implemented.** If BigCorpHR is configured to zero attributes on deactivation (GDPR customers), reactivating a user via `PATCH active:true` will restore `enabled=true` but leave the profile empty. `okta-dialect.md §4` documents this risk. BigCorpHR's current policy does not zero attributes, so this is not immediately dangerous — but document and revisit if the deactivation policy changes.

- **No PATCH retry idempotency guarantee.** If Okta retries a PATCH that already succeeded server-side, the second call is sent to BigCorpHR unchanged. BigCorpHR is expected to handle this idempotently; if it does not (e.g., returns 404 on a repeated `enabled=false` patch), the connector will surface a 404 to Okta. `okta-dialect.md §11.6 PATCH retry idempotency` — `[OPEN]`, field-bound.

- **Auth token rotation is manual.** `SCIM_AUTH_TOKEN` and `BIGCORP_HR_API_TOKEN` rotation requires a redeploy. Automated secret rotation (AWS Secrets Manager / HashiCorp Vault) is deferred to a post-hackathon infrastructure ticket.

---

## 6. On-call / escalation

| Role | Contact | When to engage |
|---|---|---|
| **Primary connector owner** | Pro Serve lead assigned to OKT-7 — update this field before prod cutover | Any connector issue in staging or prod |
| **BigCorpHR API owner** | BigCorpHR platform team (contact via customer's Slack channel) | Target API errors (5xx from BigCorpHR, auth failures on `BIGCORP_HR_API_TOKEN`) |
| **Okta tenant admin** | Customer's Okta admin (contact via customer's ticketing system) | Okta-side provisioning config changes, SCIM app reconnect after URL change |
| **P0 escalation** | PagerDuty rotation for Pro Serve (configure before prod go-live) | Production auth completely broken; users unable to provision |

### Severity + response targets (pre-production: best-effort)

| Severity | Example | Target response |
|---|---|---|
| P0 | All provisioning broken; Okta cannot authenticate to connector | 30 minutes |
| P1 | Deactivation not propagating to BigCorpHR; active users retain access | 4 hours |
| P2 | Attribute mapping wrong (e.g., department not populating) | 1 business day |
| P3 | Performance / pagination slow for large imports | Next sprint |

**Note:** the targets above are goals, not contractual SLAs. Lock in a formal SLA before the customer takes this connector into production with real users.

### Triage checklist for on-call

1. `curl /scim/v2/healthz` — is `target_reachable: true`?  If not, BigCorpHR is down or `BIGCORP_HR_API_TOKEN` expired.
2. Check connector logs (structured JSON) for `request_id` on the failing Okta request — correlate with Okta's System Log using the same timestamp window.
3. Check `scimType` in error responses — `noTarget` = user not found in BigCorpHR; `uniqueness` = duplicate userName; `invalidFilter` = Okta sent a filter the connector couldn't parse.
4. If all looks healthy but Okta reports failure, re-run **Test Connector Configuration** in the Okta admin console — Okta caches connector state and a re-test often clears transient errors.