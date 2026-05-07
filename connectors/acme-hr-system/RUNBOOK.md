# RUNBOOK — Acme HR System SCIM Connector

**Ticket:** OKT-10  
**Customer app:** Acme HR System  
**Slug:** `acme-hr-system`  
**Okta tenant:** `demo-tomato-leopon-10388.oktapreview.com`  
**Terraform workspace:** `staging`  
**Lifecycle policy:** `soft_delete` — rows are never physically removed; deactivation sets `enabled=false`  
**Source model:** LDAP-shaped REST (Pattern 1 — `docs/patterns/ldap.md`)  
**Promotion gate status:** Pre-promotion (all gates null at ticket creation; fill before prod cutover)

---

## 1. Environment variables

| Variable | Purpose | Required in prod? | Format / notes |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector on every request | **Yes** | ≥ 32 random characters. Generate with `openssl rand -hex 32`. Never commit. |
| `ACME_HR_API_TOKEN` | Bearer token this connector presents to the Acme HR System API | **Yes** | Provided by the Acme HR System admin. Rotate per their credential policy. |
| `ACME_HR_BASE_URL` | Base URL of the Acme HR System API | No (defaults to prod URL) | See environment table below. No trailing slash. |
| `CONNECTOR_PORT` | TCP port this connector listens on | No (default: `3003`) | Integer 1024–65535. |
| `NODE_ENV` | Runtime environment | No (default: `development`) | Set to `production` in staging and prod. Missing `SCIM_AUTH_TOKEN` or `ACME_HR_API_TOKEN` causes a hard exit on start when not `development`. |

### Environment-specific base URLs (ticket `environments` field)

| Environment | `ACME_HR_BASE_URL` value |
|---|---|
| dev | `https://dev.acme-hr.example.com` |
| staging | `https://staging.acme-hr.example.com` |
| prod | `https://api.acme-hr.example.com` *(default when env var is unset)* |

### .env template (dev only — never commit populated values)

```dotenv
# connectors/acme-hr-system/.env.example
SCIM_AUTH_TOKEN=replace-me-with-32-plus-random-chars
ACME_HR_API_TOKEN=replace-me-with-acme-hr-api-credential
ACME_HR_BASE_URL=https://dev.acme-hr.example.com
CONNECTOR_PORT=3003
NODE_ENV=development
```

---

## 2. Deployment

### Prerequisites

- Node.js ≥ 20.0.0 (`node --version`)
- `npm ci` completed from repo root
- Acme HR System API reachable at `ACME_HR_BASE_URL`
- Both `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` set in the environment (or `.env` for dev)

### Start the connector (dev / local)

```bash
# From repo root
ACME_HR_BASE_URL=https://dev.acme-hr.example.com \
SCIM_AUTH_TOKEN=dev-token-replace-me \
ACME_HR_API_TOKEN=dev-acme-token-replace-me \
NODE_ENV=development \
npx tsx connectors/acme-hr-system/start.ts
```

Expected startup log (JSON):
```json
{
  "event": "connector_started",
  "connector": "acme-hr-system",
  "scim_base": "http://localhost:3003/scim/v2",
  "target_base_url": "https://dev.acme-hr.example.com",
  "environment": "development",
  "auth_enabled": false,
  "okta_tenant": "demo-tomato-leopon-10388.oktapreview.com"
}
```

### Start the connector (staging / prod)

```bash
# Staging — NODE_ENV=production triggers the startup token-presence guard.
NODE_ENV=production \
ACME_HR_BASE_URL=https://staging.acme-hr.example.com \
SCIM_AUTH_TOKEN=$STAGING_SCIM_AUTH_TOKEN \
ACME_HR_API_TOKEN=$STAGING_ACME_HR_API_TOKEN \
node --import tsx/esm connectors/acme-hr-system/start.ts
```

### Verify the connector is alive

```bash
# Health check — does NOT require auth; returns 503 if target is unreachable.
curl -sS http://localhost:3003/scim/v2/healthz | jq .
# Healthy:  {"status":"ok","target_reachable":true,...}
# Degraded: HTTP 503 {"status":"degraded","target_reachable":false,...}
```

### Verify Okta connectivity (after wiring Okta app)

```bash
# Okta will GET /ServiceProviderConfig on first connect.
curl -sS \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN" \
  http://localhost:3003/scim/v2/ServiceProviderConfig | jq .patch
# Expected: {"supported":true}
```

### Connecting the Okta app

1. In the Okta admin console for `demo-tomato-leopon-10388.oktapreview.com`,
   navigate to **Applications → Acme HR System → Provisioning → Integration**.
2. Set **SCIM connector base URL** to `https://<your-host>/scim/v2`.
3. Set **Authentication mode** to `HTTP Header`.
4. Set the **Authorization** header value to `Bearer <SCIM_AUTH_TOKEN>`.
5. Click **Test Connector Configuration** — Okta GETs `/Users?count=1&startIndex=1`
   and `/ServiceProviderConfig`. Both must return 200.
6. Enable **Provisioning to App** for: Create Users, Update User Attributes,
   Deactivate Users.

### Terraform (staging workspace)

Terraform scaffolding is planned for Day 6. Until then, deploy manually:

```bash
# terraform workspace select staging
# terraform apply -auto-approve
# (Not yet wired for this connector — update this section when Terraform
#  module is available.)
```

---

## 3. Rollback

### Identify the last-known-good version

```bash
# Read the most recent Promotion Manifest for this connector.
cat connectors/acme-hr-system/promotion-manifest.json | jq '{git_tag: .manifest.git_tag, promoted_at: .manifest.promoted_to_prod_at}'
```

### Roll back staging

```bash
# 1. Check out the last-good git tag.
git checkout <last-known-good-tag>

# 2. Re-install deps (in case package-lock changed).
npm ci

# 3. Restart the connector process (kill current, start with same env vars).
NODE_ENV=production \
ACME_HR_BASE_URL=https://staging.acme-hr.example.com \
SCIM_AUTH_TOKEN=$STAGING_SCIM_AUTH_TOKEN \
ACME_HR_API_TOKEN=$STAGING_ACME_HR_API_TOKEN \
node --import tsx/esm connectors/acme-hr-system/start.ts

# 4. Re-run smoke to confirm rollback is healthy.
tsx scripts/smoke/cli.ts \
  --connector-url https://<staging-host> \
  --target-url    https://staging.acme-hr.example.com
```

### Roll back prod

A prod rollback requires the same two-of-two approver gate as a forward
promotion (Connector Law 10 — AUDIT-TRAIL). A unilateral rollback is a
security incident. Steps are identical to staging above, substituting prod
URLs and secrets.

**Blast-radius note:** rolling back the connector does NOT undo user
lifecycle changes already written to the Acme HR System API. If
`enabled=false` was written for users during a bad deployment, a rollback
alone does not re-enable them — that requires a manual remediation PATCH
or a re-sync from Okta.

---

## 4. Smoke test + verification

Three checks — all three must pass before a version is considered releasable.

### Check 1 — Health probe

```bash
curl -sS http://localhost:3003/scim/v2/healthz
# Pass: HTTP 200, body contains "status":"ok" AND "target_reachable":true
# Fail: HTTP 503 (connector alive but can't reach Acme HR System API)
```

### Check 2 — Automated smoke cycle

Provisions a test user through the SCIM layer, deactivates them, and
verifies the Acme HR System reflects `enabled=false`.

```bash
tsx scripts/smoke/cli.ts \
  --connector-url http://localhost:3003 \
  --target-url    "$ACME_HR_BASE_URL" \
  --scim-token    "$SCIM_AUTH_TOKEN"
# Pass: exit 0, JSON report with smoke_test_passed=true, log_errors_count=0
# Fail: exit 1, JSON report details which step failed
```

The smoke script exercises:
- `POST /scim/v2/Users` → verify 201
- `GET /scim/v2/Users?filter=userName eq "<userName>"` → verify 1 result (OIN step 4)
- `GET /scim/v2/Users/<id>` → verify 200 (OIN step 2)
- `PATCH /scim/v2/Users/<id>` with `{active:false}` → verify 200, verify target `enabled=false`
- `DELETE /scim/v2/Users/<id>` → verify 204, verify target `enabled=false` (soft-delete)
- `GET /scim/v2/Users/<id>` after delete → verify user still exists with `active=false`

### Check 3 — OIN replay test

Runs the 12 required OIN SPEC test flows against a live connector instance.

```bash
npm run test:replay -- --connector-url http://localhost:3003 --token "$SCIM_AUTH_TOKEN"
# Pass: 12/12 required tests green
# Fail: any red test blocks promotion
```

---

## 5. Known limitations

- **Groups not implemented.** The ticket `required_ops` does not include
  group operations, so no `GET/PATCH /scim/v2/Groups` routes exist. If the
  Okta app attempts group push, it will receive 404. To add group support,
  implement a `GroupStore` interface and wire it into the server factory.
  Estimated effort: 1–2 days following docs/patterns/ldap.md §5.

- **In-memory filter only.** `GET /Users?filter=...` fetches all users from
  the Acme HR System API and filters in-process. For tenants with > ~5 000
  active users, this will be slow and may time out on Okta's import job.
  Resolution: push filter parameters to the native API (requires Acme HR
  System to support query params — confirm with the customer's API team).

- **No filter pushdown for pagination.** Related to the above — `totalResults`
  is accurate (counted after in-memory filter) but every list request pays
  the full fetch cost.

- **`lastModified` approximates `created`.**  The Acme HR System API does not
  expose a creation timestamp. `meta.created` is set to the same value as
  `meta.lastModified`. If the customer's Okta tenant runs delta imports
  filtered by `meta.lastModified gt <timestamp>`, newly created users will
  always appear in the delta (correct behaviour) but `meta.created` will
  drift from the true creation time on updates (cosmetic issue).

- **Single-node only.** The connector is stateless but the Acme HR System
  client uses per-request native fetch — no connection pool sharing across
  processes. Horizontal scaling works but each replica makes independent
  connection sets to the target.

- **Reactivation with attribute zeroing is not configured.** This tenant does
  not have `deactivation_attribute_clearing` set, so attributes are NOT zeroed
  on deactivation. If this requirement is added later, the mapping layer and
  store must be updated together with a reactivation re-population flow.
  See okta-dialect.md §4 (reactivation gotcha) and §6.

- **Terraform not yet wired.** Terraform workspace `staging` is referenced in
  the ticket but the module for this connector has not been created. Manual
  deployment is required until that work is completed.

---

## 6. On-call / escalation

| Role | Contact | Method |
|---|---|---|
| Primary connector owner (Pro Serve) | Louis Migault | Slack DM `@louis` |
| Secondary / backup | TBD — assign before first prod customer cutover | Slack `#proserve-oncall` |
| Acme HR System API issues | Acme HR System team — `api-support@acme-hr.example.com` | Email + ticket in their system |
| Okta tenant admin | Demo tenant admin — `demo-tomato-leopon-10388.oktapreview.com` | Okta admin console |

### Incident classification

| Class | Description | Target response |
|---|---|---|
| P0 | Production auth broken — users cannot provision / deprovision | 30 minutes |
| P1 | Partial provisioning failures (subset of users affected) | 4 hours |
| P2 | Non-critical degradation (e.g., slow imports, stale data) | 1 business day |
| P3 | Cosmetic / minor (wrong display name field, etc.) | Next sprint |

### Triage checklist for on-call

1. **Check health:** `curl https://<connector-host>/scim/v2/healthz`
   - `target_reachable: false` → Acme HR System API is down or credential expired.
     Escalate to Acme HR System team.
   - `status: "degraded"` with connector itself responding → connector is alive,
     target is not.

2. **Check recent Okta provisioning logs:**
   Okta admin console → Applications → Acme HR System → Provisioning → Logs.
   Look for 4xx or 5xx codes on recent sync events.

3. **Check connector process logs:**
   Each request has a `request_id` header. Grep for the request ID from the
   Okta provisioning log to find the full server-side trace.
   `grep "<request_id>" /var/log/acme-hr-system-connector.log`

4. **Common failure modes:**
   - `401 Unauthorized` in Okta logs → `SCIM_AUTH_TOKEN` rotated on connector
     side without updating Okta's app configuration (or vice versa).
   - `409 Conflict` on user create → duplicate `userName`; check if user already
     exists in Acme HR System with the same uid.
   - `404 Not Found` on user PATCH → Okta has a stale `id` (uid) for this user;
     may indicate a uid change in the Acme HR System (uid is supposed to be
     immutable — see okta-dialect.md §11.5 `externalId` semantics).
   - `503` on healthz → Acme HR System API unreachable. Check network path,
     firewall rules, and whether `ACME_HR_API_TOKEN` is still valid.

### Soft-delete verification

If a user deactivation is suspected to have not propagated:

```bash
# 1. Find the user's uid (= SCIM id) from Okta's provisioning log.
# 2. Query the Acme HR System directly to check enabled status.
curl -sS \
  -H "Authorization: Bearer $ACME_HR_API_TOKEN" \
  "$ACME_HR_BASE_URL/users/<uid>" | jq .enabled
# Expected after deactivation: false
# If still true: the PATCH did not reach the target. Re-trigger from
# Okta admin console: Applications → Acme HR System → Assignments →
# select user → Reactivate / Force sync.
```