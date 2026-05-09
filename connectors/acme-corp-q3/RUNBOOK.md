# RUNBOOK — Acme Corp Q3 SCIM Connector

**Ticket:** OKT-54  
**Customer app:** Custom SCIM Connector for Internal HR System  
**Slug:** `acme-corp-q3`  
**Okta tenant:** `demo-tomato-leopon-10388.oktapreview.com`  
**Terraform workspace:** `staging`  
**Lifecycle policy:** `soft_delete` — users are deactivated (`enabled: false`) on Okta deprovision; rows are never hard-deleted.  
**Auth:** Bearer token (SCIM side + HR API side, separate tokens)

---

## 1. Environment variables

| Variable | Purpose | Required in prod? | Format / notes |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector. Validated by the skeleton's auth middleware on every `/scim/v2/*` request. | **Yes** | ≥ 32 random chars. Rotate via HR-side secret manager; redeploy connector after rotation. |
| `ACME_CORP_Q3_API_TOKEN` | Bearer token this connector presents to the Internal HR API. Set per `auth_credential_env_var` in ticket OKT-54. | **Yes** | ≥ 32 random chars. Provided by the Acme Corp Q3 platform team. |
| `ACME_CORP_Q3_BASE_URL` | HR API base URL. | No | Default: `https://api.acme-corp-q3.example.com`. Override for dev: `https://api.dev.acme-corp-q3.example.com`. |
| `CONNECTOR_PORT` | TCP port the connector listens on. | No | Default: `3003`. Change if port conflicts with other connectors on the same host. |
| `PROMOTION_SIGNING_KEY_CURRENT` | HMAC key for Promotion Manifest signing (Law 10 AUDIT-TRAIL). | Yes on sign/verify | ≥ 32 chars. Kept in secrets manager; not passed to connector at runtime. |
| `PROMOTION_SIGNING_KEY_CURRENT_ID` | Human-readable key ID stamped into manifest envelope. | No | Default: `current`. |

**Never hard-code secrets.** All tokens are injected via env at runtime. Law 4 SECRETS-OUT.

In dev mode, omit `SCIM_AUTH_TOKEN` and `ACME_CORP_Q3_API_TOKEN` — the connector will start and log warnings but will not reject requests. This is intentional for local iteration. **Never deploy to prod without both tokens set.**

---

## 2. Deployment

### Prerequisites

- Node.js 20+, `npm ci` completed in repo root.
- Network access from the connector host to `ACME_CORP_Q3_BASE_URL` (HR API endpoint).
- Network access from the Okta tenant (`demo-tomato-leopon-10388.oktapreview.com`) to the connector's public URL.
- `SCIM_AUTH_TOKEN` and `ACME_CORP_Q3_API_TOKEN` injected into the runtime environment.

### Local development

```bash
# Export env vars (never commit these)
export SCIM_AUTH_TOKEN=your-dev-scim-token-here
export ACME_CORP_Q3_API_TOKEN=your-dev-hr-api-token-here
export ACME_CORP_Q3_BASE_URL=https://api.dev.acme-corp-q3.example.com
export CONNECTOR_PORT=3003

# Start the connector
npx tsx connectors/acme-corp-q3/start.ts
# Expected: JSON log line: "Acme Corp Q3 SCIM connector listening" on http://localhost:3003/scim/v2
```

### Staging (Terraform)

```bash
terraform workspace select staging
terraform apply -auto-approve
# Connector is deployed as a service; SCIM_AUTH_TOKEN and ACME_CORP_Q3_API_TOKEN
# are injected from the staging secrets store.
```

### Configuring the Okta SCIM app

1. In the Okta admin console for `demo-tomato-leopon-10388.oktapreview.com`, navigate to **Applications → your app → Provisioning → API Integration**.
2. Set **SCIM connector base URL** to `https://<connector-public-host>/scim/v2`.
3. Set **Unique identifier field for users** to `userName`.
4. Set **Authentication mode** to `HTTP Header` and paste the value of `SCIM_AUTH_TOKEN`.
5. Click **Test API Credentials** — expect a green check. This calls `GET /scim/v2/Users?count=1&startIndex=1` (OIN test suite step 0).
6. Enable provisioning features: **Create**, **Update**, **Deactivate** (maps to PATCH `active:false`).
7. **Do not enable** Push Groups unless group support is added (see Known Limitations).

---

## 3. Rollback

### If staging smoke fails before promotion

Do **not** promote. Fix the ticket, re-generate the connector, re-run smoke, then re-promote.

```bash
# Re-run smoke after a fix
tsx scripts/smoke/cli.ts \
  --connector-url https://<staging-connector-host> \
  --target-url    https://api.dev.acme-corp-q3.example.com
```

### If production goes wrong after promotion

```bash
# 1. Identify last-known-good git tag from the prior Promotion Manifest.
jq -r .manifest.git_tag last-good-manifest.json

# 2. Checkout that ref.
git checkout <last-known-good-tag>

# 3. Re-deploy (once Terraform is wired for prod workspace).
terraform workspace select prod
terraform apply -auto-approve

# 4. Re-run smoke against prod.
tsx scripts/smoke/cli.ts \
  --connector-url https://<prod-connector-host> \
  --target-url    https://api.acme-corp-q3.example.com

# 5. File a post-mortem within 24 hours.
```

**Blast-radius note:** production rollback requires the same two-approver gate as a forward promotion (Connector Law 10 AUDIT-TRAIL). A unilateral rollback without the approval record is a security incident. Approval is recorded in the Promotion Manifest.

---

## 4. Smoke test + verification

All three checks must pass. Run them in order.

### 4a. Health probe

```bash
curl -sS http://localhost:3003/scim/v2/healthz
```

**Healthy response (HTTP 200):**
```json
{
  "status": "ok",
  "uptime_seconds": 12,
  "version": "dev",
  "target_reachable": true
}
```

**Degraded response (HTTP 503) — HR API unreachable:**
```json
{
  "status": "degraded",
  "target_reachable": false,
  "target_error": "fetch failed: ECONNREFUSED"
}
```

If degraded, verify `ACME_CORP_Q3_BASE_URL` is correct and the HR API is running.

### 4b. SCIM smoke cycle (provision + deactivate + verify)

```bash
tsx scripts/smoke/cli.ts \
  --connector-url http://localhost:3003 \
  --target-url    https://api.dev.acme-corp-q3.example.com
```

Expected: exit 0, JSON report with `smoke_test_passed: true`, `log_errors_count: 0`.

The smoke script:
1. Creates a test user via `POST /scim/v2/Users`.
2. Reads the user back via `GET /scim/v2/Users/{id}`.
3. Filters by `userName eq` to confirm the OIN step 16 case-sensitive filter works.
4. Patches `active: false` (simulating Okta deprovision).
5. **Verifies at the target** that the HR API row now has `enabled: false` (the soft_delete check — catches connector lies).
6. Attempts a duplicate create and asserts 409 + `scimType: uniqueness` (OIN step 14).
7. Attempts a `GET /scim/v2/Users/<nonexistent>` and asserts 404 (OIN step 22).

### 4c. OIN test suite pre-check

Before OIN submission, run Okta's hosted test suite against the staging connector URL. Paste the connector base URL into Okta's SCIM test tool. All 12 required tests must pass (see `docs/okta-dialect.md §12` for the full list).

Key tests and what they verify against this connector:

| OIN Step | What it hits | Expected result |
|---|---|---|
| 0 | `GET /Users?count=1&startIndex=1` | ListResponse with correct pagination fields |
| 4, 8 | `GET /Users?filter=userName eq "<invalid>"` | Empty ListResponse (NOT 404) |
| 6 | `GET /Users/<nonexistent>` | 404 + SCIM error envelope |
| 10 | `POST /Users` | 201 + user body with uid as id |
| 14 | Re-POST same user | 409 + `scimType: "uniqueness"` |
| 16 | `GET /Users?filter=userName eq "SOMEUSER"` vs `"someuser"` | Case-sensitive: different results |
| 20 | Missing/bad `Authorization` header | 401 |

---

## 5. Known limitations

- **Groups not implemented.** Ticket OKT-54 sets `required_ops` to users-only. Group push (`/scim/v2/Groups`) is not wired. If the customer enables Push Groups in the Okta app, group operations will return 404. Add group support in a follow-on ticket.

- **In-memory filter (no server-side pushdown).** `GET /Users?filter=...` fetches all HR API users into memory and filters client-side. For tenants with > 5,000 users this will be slow and may cause timeouts on initial import. If the HR API exposes a search/filter endpoint, add pushdown in `client.ts` and `store.ts` to avoid full fetches.

- **No log shipping.** Structured JSON is emitted to stdout (Connector Law 8 OBSERVABLE). Shipping to a central log store (CloudWatch, Loki, Datadog) is a deployment-level concern not configured here. Wire it in the Terraform module.

- **No metric emission.** Prometheus/OpenTelemetry metrics are not instrumented. Request latency, error rates, and target-API call counts are observable only through the structured logs. Add an OTel exporter for production SLO monitoring.

- **Single-node only.** The connector is stateless (all state lives in the HR API). Horizontal scaling works without coordination — but the Terraform module currently provisions one node. Scale by increasing the replica count in the module.

- **Token rotation is manual.** Rotating `SCIM_AUTH_TOKEN` or `ACME_CORP_Q3_API_TOKEN` requires a redeployment. Wire automatic rotation via the secrets manager + a deploy trigger for zero-downtime rotation.

- **`meta.created` is approximated.** The HR API exposes only `lastModified`, not a separate creation timestamp. `meta.created` is set equal to `meta.lastModified` for all users. If the HR API adds a `createdAt` field in future, update `mapping.ts` `acmeCorpQ3ToScim()` to map it directly.

- **Soft-delete only — no archive tier.** The lifecycle policy is `soft_delete`. If the customer later requires GDPR attribute zeroing on deactivation (see `okta-dialect.md §6`), that must be added in a follow-on ticket with explicit sign-off on which fields to zero and the reactivation flow.

---

## 6. On-call / escalation

| Role | Contact | Coverage |
|---|---|---|
| **Primary (connector owner)** | Okta Pro Serve lead assigned to OKT-54 — see Linear ticket for assignee | Business hours during staging validation; 24×7 once in production |
| **Secondary (Pro Serve backup)** | Pro Serve team Slack channel `#okta-proserve-connectors` | Best-effort; escalate P0/P1 via PagerDuty once production on-call rotation is configured |
| **Acme Corp Q3 platform team** | Contact provided in OKT-54 Linear ticket comments — HR API owner | Required for any issues on the HR API side (auth, data shape changes, API outages) |
| **Okta support** | https://support.okta.com — reference tenant `demo-tomato-leopon-10388.oktapreview.com` | For Okta-side provisioning failures that are not connector errors |

### SLA targets (staging → production)

| Priority | Definition | Response target |
|---|---|---|
| P0 | All users locked out of customer app; provisioning completely broken | 30 minutes |
| P1 | Partial provisioning failure; deactivations not propagating | 4 hours |
| P2 | Non-critical attribute sync issues; cosmetic errors | 1 business day |

**Note:** SLA targets above are aspirational for the staging phase. Formal SLAs require a signed Services Agreement. Confirm with the engagement manager before committing these to the customer.

### Incident runbook (P0 triage checklist)

1. Check `/healthz` — is `target_reachable: true`? If not, the HR API is down; escalate to Acme Corp Q3 platform team immediately.
2. Check Okta's provisioning error log in the admin console (Applications → app → Provisioning → Activity). What HTTP status is the connector returning?
3. Check connector stdout logs for structured error lines (filter by `level: "error"`).
4. If the connector is returning 401: verify `SCIM_AUTH_TOKEN` is set correctly and matches what Okta is sending.
5. If the connector is returning 500: check for HR API errors in the logs (`AcmeCorpQ3ApiError`). May indicate an HR API schema change — compare `types.ts` against the current HR API response.
6. If the issue is in Okta's provisioning engine (not the connector): open an Okta support ticket with the request/response trace from step 2.
7. If rollback is needed: follow §3 (Rollback) above. Require two-approver sign-off.