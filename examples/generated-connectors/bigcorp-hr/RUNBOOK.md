# RUNBOOK — BigCorpHR SCIM Connector

**Connector:** `bigcorp-hr`
**Ticket:** SCIM-LIVE-PROBE
**Target Okta tenant:** `demo-customer-a-staging.oktapreview.com`
**Terraform workspace:** `staging`
**Lifecycle policy:** `soft_delete` — rows are never deleted; deactivation sets `enabled: false`
**User model source:** LDAP-shaped (Pattern 1 — see `docs/attribute-mapping-patterns.md`)

---

## 1. Environment variables

All credentials arrive through environment variables. No secrets are
hard-coded anywhere in the connector source (Connector Law 4 SECRETS-OUT).

| Variable | Purpose | Required? | Format / Notes |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector | **Yes in prod**, optional in dev | ≥ 32 chars, randomly generated. Missing in prod → process exits non-zero. |
| `BIGCORP_HR_API_TOKEN` | Bearer token this connector presents to BigCorpHR's API | **Yes in prod**, optional in dev | Issued by BigCorpHR admin. See `auth_credential_env_var` in ticket. |
| `BIGCORP_HR_BASE_URL` | BigCorpHR API base URL | No (defaults to `https://api.bigcorp-hr.example.com`) | Override for staging vs. prod target endpoints. |
| `CONNECTOR_PORT` | TCP port the connector listens on | No (defaults to `3003`) | Integer. Must be open in the security group / firewall. |
| `NODE_ENV` | Runtime mode | No (defaults to `development`) | Set to `production` to enable hard-exit on missing required vars. |

### Secret rotation procedure

1. Generate a new `SCIM_AUTH_TOKEN` value (≥ 32 random chars, base64url recommended).
2. Update the value in your secrets manager (Vault / AWS Secrets Manager / etc.).
3. Re-deploy the connector (rolling restart). Old requests with the old token
   will fail with 401 briefly during the rollout window — this is acceptable.
4. Update the Okta application's SCIM credentials in the Okta admin console to
   the new token within the rollout window.
5. Verify: `curl -H "Authorization: Bearer <NEW_TOKEN>" https://<connector-url>/scim/v2/ServiceProviderConfig`
   should return 200.

Do NOT reuse tokens across Okta tenants or connectors.

---

## 2. Deployment

### Prerequisites

- Node.js 20+ (`node --version` should show `v20.x.x` or higher)
- `npm ci` completed in the repo root
- BigCorpHR API reachable at `BIGCORP_HR_BASE_URL`
- Environment variables set (see §1 above)

### Local / dev startup

```bash
# From repo root
BIGCORP_HR_BASE_URL=https://api.bigcorp-hr.example.com \
BIGCORP_HR_API_TOKEN=<your-dev-token> \
SCIM_AUTH_TOKEN=<your-dev-scim-token> \
CONNECTOR_PORT=3003 \
npx tsx connectors/bigcorp-hr/start.ts
# Expected log line:
# {"level":"info","event":"connector_started","connector":"bigcorp-hr","port":3003,"scim_base":"http://localhost:3003/scim/v2",...}
```

### Staging deployment (Terraform)

```bash
# Ensure you are in the correct workspace
terraform workspace select staging

# Review the plan — verify connector image tag and env var references
terraform plan

# Apply
terraform apply -auto-approve

# Wait for the health check to go green (typically < 60 s)
watch 'curl -sS https://<staging-connector-url>/scim/v2/healthz'
# Expected: {"status":"ok","target_reachable":true,...}
```

### Production deployment

Same as staging, swapping workspace:

```bash
terraform workspace select prod
terraform plan   # MANDATORY: review before apply in prod
terraform apply  # Two-of-two approval required per Connector Law 10 (AUDIT-TRAIL)
```

A signed Promotion Manifest (per Law 10) must be generated and stored in the
audit log before any production deployment. The manifest pins the git commit,
the environment variable checksums (not values), and the approver identities.

### Okta provisioning app configuration

After the connector is reachable:

1. In Okta Admin Console → Applications → BigCorpHR → Provisioning → Integration
2. Set **SCIM connector base URL** to `https://<connector-url>/scim/v2`
3. Set **Unique identifier field** to `userName`
4. Set **Authentication** → Bearer token → paste `SCIM_AUTH_TOKEN` value
5. Click **Test API Credentials** → should return green
6. Enable: **Import Users**, **Push New Users**, **Push Profile Updates**, **Deactivate Users**
7. Optionally enable **Reactivate Users** (see §5 limitations on reactivation)

---

## 3. Rollback

### Identifying the last-known-good version

The Promotion Manifest for each deployment is stored in the audit log.
Retrieve the last successful manifest:

```bash
# Example — adapt to your audit log location
cat audit-log/manifests/bigcorp-hr-staging-last-good.json | jq -r .manifest.git_sha
# e.g. a3f1c2d
```

### Rollback procedure

```bash
# 1. Check out the last-known-good commit
git checkout <last-known-good-sha>

# 2. Re-apply in the correct workspace
terraform workspace select staging   # or prod
terraform apply -auto-approve

# 3. Run smoke test (§4) to confirm rollback is healthy
tsx scripts/smoke/cli.ts \
  --connector-url https://<connector-url> \
  --target-url    https://api.bigcorp-hr.example.com

# 4. Notify on-call channel that rollback completed + reason
```

**Rollback in production requires two-of-two approval** (same as a forward
promotion — Connector Law 10). A unilateral prod rollback without approval
is a security incident; open a P0 ticket immediately.

### Emergency: connector completely unreachable

If the connector is down and Okta is retrying:

1. Okta will back off with exponential retry up to 10 attempts, then surface
   a provisioning error in the admin UI. No user data is lost.
2. Restore the connector (rollback or fix-forward).
3. Okta will resume on the next scheduled import/push cycle (typically within
   15 minutes). Manually trigger "Import Now" in Okta if urgency requires it.

---

## 4. Smoke test + verification

Three checks; all three must pass before declaring the deployment healthy.

### Check 1: Health probe

```bash
curl -sS https://<connector-url>/scim/v2/healthz
```

Expected (healthy):
```json
{
  "status": "ok",
  "uptime_seconds": 42,
  "version": "dev",
  "target_reachable": true
}
```

Expected (degraded — BigCorpHR unreachable):
```json
{
  "status": "degraded",
  "target_reachable": false,
  "target_error": "fetch failed: ..."
}
```
HTTP status 503 when degraded. Alert on non-200 from this endpoint.

### Check 2: Authentication rejection (OIN test step 20)

```bash
curl -sS -o /dev/null -w "%{http_code}" https://<connector-url>/scim/v2/Users
# Expected: 401

curl -sS -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer WRONG_TOKEN" \
  https://<connector-url>/scim/v2/Users
# Expected: 401
```

### Check 3: Full smoke cycle (provision → deactivate → verify)

```bash
tsx scripts/smoke/cli.ts \
  --connector-url https://<connector-url> \
  --target-url    https://api.bigcorp-hr.example.com
```

Expected output:
```
✓ create user: 201
✓ get user: 200, active=true
✓ patch deactivate: 200, active=false
✓ target verify: enabled=false (soft_delete confirmed — row retained)
✓ delete user: 204
✓ target verify after delete: enabled=false (row retained, not hard-deleted)
smoke_test_passed: true
log_errors_count: 0
```

The `target verify` step after DELETE is critical: it confirms that the
soft_delete policy is honoured — the row still exists in BigCorpHR with
`enabled: false`. A hard-delete would cause this step to return 404, which
would fail the smoke test.

### Check 4: OIN-gating filter test (manual, mirrors step 4/8/16)

```bash
TOKEN=<your-scim-auth-token>

# Step 4/8: non-existent userName returns empty ListResponse (NOT 404)
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://<connector-url>/scim/v2/Users?filter=userName+eq+%22nonexistent-user-xyz%22"
# Expected: {"totalResults":0,"Resources":[]}

# Step 16: case-sensitivity check
# Create a user first, e.g. userName="CaseSensUser"
# Then filter with a different case — must return empty
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://<connector-url>/scim/v2/Users?filter=userName+eq+%22casesensuser%22"
# Expected: {"totalResults":0} — NOT the user created with "CaseSensUser"
```

---

## 5. Known limitations

- **Groups not implemented.** `required_ops` in the ticket does not include
  groups (`users_*` only). The connector does not mount `/Groups` routes.
  If BigCorpHR's group-push requirements arise later, add a `BigCorpHrGroupStore`
  and mount `groupsRouter` alongside the users router in `server.ts`.

- **In-memory filter (no pushdown).** `GET /Users?filter=...` fetches all
  BigCorpHR users and filters in memory (Pattern 1 pragmatic approach per
  `docs/attribute-mapping-patterns.md §5`). For BigCorpHR instances with
  large user populations (> 5,000 users), this adds latency on every list
  call. Mitigation: implement `GET /users?filter=uid:eq:<value>` on
  BigCorpHR's API and push `userName eq` filters down through the client.
  Tracked as future work.

- **No filter pushdown for `meta.lastModified gt`.**  Incremental / delta
  imports by Okta using temporal filters will load all users. Same
  mitigation as above — BigCorpHR would need a `?since=<timestamp>` API
  parameter. Not present in current API spec.

- **Reactivation with stale attributes.** If the BigCorpHR admin manually
  clears user attributes alongside deactivation (outside this connector),
  and then reactivation (PATCH `active:true`) is sent by Okta, the user
  will be reactivated with whatever attributes BigCorpHR currently holds.
  Per `okta-dialect.md §4` (field-confirmed, costs hours): if the customer
  wants attribute-restoration on reactivation, the connector must re-fetch
  Okta profile attributes and re-push. This is not yet implemented; document
  to the BigCorpHR admin team that they should re-push profile attributes
  from Okta after reactivating a user.

- **Single-node only.** The connector is stateless (all state lives in
  BigCorpHR's API), so horizontal scaling is architecturally safe. However,
  the current Terraform scaffold provisions a single instance. Scale-out
  requires updating the ECS task count / K8s replica count.

- **Bearer token only.** The connector implements bearer token auth
  (`auth_method: bearer`, ticket SCIM-LIVE-PROBE). OAuth 2.0 Authorization
  Code flow is not wired. If the BigCorpHR admin requires OAuth, the
  skeleton's `bearerAuth` middleware must be replaced with an OAuth flow
  per `okta-dialect.md §9`.

- **`meta.created` is approximate.** BigCorpHR does not expose a separate
  `createdAt` timestamp. The connector emits `lastModified` for both
  `meta.created` and `meta.lastModified` as a conservative approximation
  per `okta-dialect.md §11.6`. If BigCorpHR adds a `createdAt` field in a
  future API version, update `mapping.ts:bigCorpHrToScim`.

---

## 6. On-call / escalation

**Primary contact (connector owner):**
Set your name + Slack handle here before deploying to production.
Example: `Alice Smith — @alice in #scim-connectors`

**Secondary (Pro Serve backup):**
Set before any production customer cutover. Must be reachable 24/7 for P0.

**Escalation path:**

| Severity | Definition | Response target | Escalation |
|---|---|---|---|
| P0 | Customer prod auth broken — users cannot log in | 30 minutes | Page on-call, open bridge, notify Okta TAM |
| P1 | Provisioning failing for >10% of users | 4 hours | Slack #scim-connectors, on-call backup |
| P2 | Intermittent provisioning errors, < 10% impact | 1 business day | #scim-connectors, async |
| P3 | Non-urgent (perf, cosmetic, docs) | Next sprint | Jira ticket |

**PagerDuty rotation:**
Configure before prod go-live. For staging / hackathon environments,
best-effort coverage during business hours only.

**Okta support ticket:**
For issues that appear to be Okta-side (e.g. Okta stops sending PATCH bodies,
unexpected filter shapes not in `okta-dialect.md`), open a ticket with Okta
support and include:
- Connector request ID (from `X-Request-Id` response header)
- Timestamp range
- Exact HTTP method + path + sanitised request body (PII removed)
- Expected vs. observed SCIM response

**Key runbook cross-references:**
- `docs/okta-dialect.md` — Okta SCIM quirks that inform every code decision
- `docs/attribute-mapping-patterns.md` Pattern 1 — LDAP-shaped source reference
- `connectors/acme-hr/RUNBOOK.md` — reference implementation runbook this file mirrors