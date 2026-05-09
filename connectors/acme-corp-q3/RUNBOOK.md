# RUNBOOK — acme-corp-q3 SCIM Connector

**Ticket:** OKT-60  
**App name:** SCIM Connector for Internal HR System  
**Customer slug:** `acme-corp-q3`  
**Okta tenant:** `demo-tomato-leopon-10388.oktapreview.com`  
**Terraform workspace:** `staging`  
**Lifecycle policy:** `soft_delete` — users are NEVER hard-deleted from the HR system. Deactivation and DELETE both set `enabled=false`; the row is retained for audit.

---

## 1. Environment variables

| Variable | Purpose | Required in prod? | Format / notes |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector on every SCIM request | **Yes** | ≥ 32 random chars; rotate via HR system admin panel |
| `ACME_CORP_Q3_API_TOKEN` | Bearer token this connector presents to the Internal HR System API | **Yes** | Issued by HR system admin; stored in your secrets manager |
| `ACME_CORP_Q3_BASE_URL` | Base URL of the HR system API | No (defaults to prod) | Prod: `https://api.acme-corp-q3.example.com` · Dev: `https://api.dev.acme-corp-q3.example.com` |
| `CONNECTOR_PORT` | TCP port the SCIM server listens on | No (defaults to `3003`) | Integer; must be open in your firewall / security group |

**Dev-mode shortcut:** omit `SCIM_AUTH_TOKEN` and `ACME_CORP_Q3_API_TOKEN` to run without auth (the connector and target both pass-through when unset). **Never deploy to production without both tokens set.** The connector logs a `WARNING` on startup when either is absent.

**Secret rotation procedure:**
1. Generate a new token value (≥ 32 random chars, e.g. `openssl rand -hex 32`).
2. Update the secret in your secrets manager.
3. Restart the connector process (or rolling-deploy the container) — the new value is read on startup.
4. Update the corresponding field in the Okta app provisioning settings (Okta Admin → Applications → acme-corp-q3 → Provisioning → API Integration).
5. Verify with the smoke test below.

---

## 2. Deployment

### Prerequisites

- Node.js 20+
- `npm ci` completed at repo root
- HR system API reachable at `ACME_CORP_Q3_BASE_URL`
- `SCIM_AUTH_TOKEN` and `ACME_CORP_Q3_API_TOKEN` set in your environment or secrets manager

### Local / dev startup

```bash
# Export required env vars (use a .env file + dotenv-cli in real dev setups):
export ACME_CORP_Q3_BASE_URL=https://api.dev.acme-corp-q3.example.com
export ACME_CORP_Q3_API_TOKEN=<dev-token>
export SCIM_AUTH_TOKEN=<dev-scim-token>
export CONNECTOR_PORT=3003

# Start the connector:
npx tsx connectors/acme-corp-q3/start.ts
# Expected log: {"level":"info","msg":"acme-corp-q3 SCIM connector started","scim_base":"http://0.0.0.0:3003/scim/v2",...}
```

### Verify the connector is up

```bash
# Health check (no auth required on /healthz):
curl -sS http://localhost:3003/scim/v2/healthz
# Expected (healthy):   {"status":"ok","target_reachable":true,...}
# Expected (degraded):  HTTP 503 {"status":"degraded","target_error":"..."}

# Metadata (no auth required by default):
curl -sS http://localhost:3003/scim/v2/ServiceProviderConfig | jq .patch
# Expected: {"supported":true}
```

### Staging deploy (Terraform)

```bash
terraform workspace select staging
terraform apply -auto-approve
# The apply sets SCIM_AUTH_TOKEN + ACME_CORP_Q3_API_TOKEN from Terraform variables
# (backed by your secrets manager). Connector port 3003 exposed via the load balancer.
```

### Okta app configuration

In Okta Admin console → Applications → acme-corp-q3:

1. **Provisioning → API Integration:**
   - SCIM connector base URL: `https://<your-connector-host>/scim/v2`
   - Authentication mode: `HTTP Header`
   - Authorization: `Bearer <SCIM_AUTH_TOKEN value>`
2. **Provisioning → To App:** enable Create Users, Update User Attributes, Deactivate Users.
3. **Provisioning → To Okta:** enable only if bidirectional sync is required (not in OKT-60 scope).

---

## 3. Rollback

### Staging rollback (before prod promotion)

The promotion gate (`promotion_gate`) in OKT-60 is not yet populated (`preprod_verified_at: null`). Do **not** promote to prod until all gate fields are set and two approvers have signed off (Connector Law 10 AUDIT-TRAIL).

If staging breaks after a deploy:

```bash
# 1. Identify the last-known-good git tag from the Promotion Manifest.
jq -r .manifest.git_tag last-good-manifest.json

# 2. Check out that ref.
git checkout <last-known-good-tag>

# 3. Re-apply staging.
terraform workspace select staging
terraform apply -auto-approve

# 4. Verify health + smoke.
curl -sS https://<staging-connector-host>/scim/v2/healthz
```

### Production rollback (post-promotion)

A production rollback requires the same two-of-two approver sign-off as a forward promotion (Connector Law 10). A unilateral rollback is a security incident.

```bash
# 1. Identify the last-known-good production tag.
jq -r .manifest.git_tag prod-last-good-manifest.json

# 2. Check out.
git checkout <prod-last-good-tag>

# 3. Re-apply prod.
terraform workspace select prod
terraform apply -auto-approve

# 4. Run smoke against prod.
tsx scripts/smoke/cli.ts \
  --connector-url https://<prod-connector-host> \
  --target-url    https://api.acme-corp-q3.example.com
```

### Soft-delete safety note

The `soft_delete` lifecycle policy means no data is lost during a rollback — the HR system retains all user rows regardless of which connector version is running. A rollback will not "un-deactivate" previously deactivated users; reactivation requires an explicit PATCH `active: true` from Okta.

---

## 4. Smoke test + verification

Three checks, all must pass before a staging → prod promotion:

### 4a. Health probe

```bash
curl -sS https://<connector-host>/scim/v2/healthz
# Must return HTTP 200 with {"status":"ok","target_reachable":true}
```

### 4b. Full smoke cycle

```bash
tsx scripts/smoke/cli.ts \
  --connector-url https://<connector-host> \
  --target-url    https://api.acme-corp-q3.example.com
# Must exit 0 with smoke_test_passed=true, log_errors_count=0
# The smoke script: creates a user, reads it back, deactivates it (PATCH active=false),
# verifies the target reflects enabled=false, then issues a DELETE and verifies
# the row is still present (soft_delete policy check).
```

### 4c. OIN replay test

```bash
npm run test:replay -- --slug acme-corp-q3
# Must pass all 12 required OIN SPEC test equivalents (okta-dialect.md §12 Appendix).
# Specifically verifies:
#   - GET /Users?count=1&startIndex=1 returns valid ListResponse (step 0)
#   - POST /Users returns 201 (step 10)
#   - Duplicate POST returns 409 + scimType:uniqueness (step 14)
#   - Filter case-sensitivity (step 16): userName eq "FOO" ≠ userName eq "foo"
#   - Missing/invalid auth returns 401 (step 20)
#   - Unknown user ID returns 404 (step 22)
```

### 4d. Manual DELETE soft-delete verification

```bash
# Create a user:
USER_ID=$(curl -sS -X POST https://<connector-host>/scim/v2/Users \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"smoke-delete-test","emails":[{"value":"smoke-delete@example.com","primary":true}],"active":true}' \
  | jq -r .id)

# Issue DELETE:
curl -sS -X DELETE https://<connector-host>/scim/v2/Users/$USER_ID \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN"
# Expected: HTTP 204 No Content

# Verify HR system row is soft-deleted (enabled=false), NOT removed:
curl -sS https://api.acme-corp-q3.example.com/users/$USER_ID \
  -H "Authorization: Bearer $ACME_CORP_Q3_API_TOKEN" | jq .enabled
# Expected: false  (NOT a 404 — the row must still exist)
```

---

## 5. Known limitations

- **No server-side filter pushdown.** `GET /Users?filter=...` fetches all HR system users into memory and filters in-process. For tenants with more than ~10,000 users this will be slow and memory-intensive. Mitigation: push `filter=userName eq "<value>"` down to a HR system `/users?uid=<value>` query endpoint if the HR system exposes one (add a `queryByUid` method to `client.ts` and an early-exit branch in `store.list()`).

- **No group push support.** `required_ops.groups` is not enabled in OKT-60. The connector does not implement `GET /Groups` or `PATCH /Groups/:id`. If group push is enabled in the Okta app settings, group operations will return 404. Do not enable group push until the groups surface is implemented.

- **No bidirectional (Okta ← HR) import.** The connector is push-only (Okta → HR). Importing users from the HR system into Okta requires implementing `GET /Users` with `meta.lastModified gt <timestamp>` filter support and enabling "Import Users" in Okta's provisioning settings. Not in OKT-60 scope.

- **`listUsers()` used as `/healthz` ping.** The health probe calls `client.listUsers()` to verify HR system reachability. For large user bases this fetches the entire user list. If the HR system exposes a cheaper liveness endpoint (e.g. `GET /ping` or `HEAD /users`), update `store.ping()` to use it.

- **Single-instance only.** The connector is stateless by design (all state lives in the HR system); it can be horizontally scaled, but the current Terraform scaffold assumes one node. Update the Terraform module to a target-group + auto-scaling-group before scaling out.

- **Timestamp precision.** `meta.lastModified` drops milliseconds (emits `YYYY-MM-DDTHH:mm:ssZ`) per the conservative default in okta-dialect.md §11.6. If the HR system's `lastModified` field includes sub-second precision that matters for delta-import ordering, remove the `dropMillis()` call in `mapping.ts` and verify Okta's import parser handles fractional seconds (behavior is `[OPEN]` per okta-dialect.md §11.6).

- **PATCH filter-path parsing is partial.** The `emails[type eq "work"].value` filter-path is handled as a string-match special case in `mapping.ts:applyPathValue`. A fully general RFC 7644 §3.4.2.2 filter-path parser is not implemented. If the Okta app attribute mappings emit other complex filter-path patterns (e.g. `phoneNumbers[type eq "mobile"].value`), add matching cases to `applyPathValue`.

---

## 6. On-call / escalation

| Role | Contact | Notes |
|---|---|---|
| Primary connector owner | Fill before go-live | Slack handle + PagerDuty rotation |
| Okta Professional Services lead | Louis Migault | Slack DM — for connector architecture questions |
| HR system API owner | Fill before go-live | The team that owns `api.acme-corp-q3.example.com` |
| P0 escalation path | Fill before go-live | PagerDuty policy for the customer's on-call rotation |

**SLA targets (to be confirmed with customer before prod go-live):**

| Severity | Definition | Response target |
|---|---|---|
| P0 | Okta provisioning completely broken; no users can be created or deactivated | 30 minutes |
| P1 | Partial failure (e.g. deactivation works, create fails); some users affected | 4 hours |
| P2 | Non-blocking issue (e.g. health probe degraded, filter slow) | 1 business day |

**Incident response checklist:**

1. Check `/healthz` first — distinguishes "connector is down" from "HR system is unreachable".
2. Check connector logs for `request_id` — every SCIM request is tagged with a request ID for correlation.
3. If `target_reachable: false` in `/healthz`, escalate to the HR system API owner.
4. If auth failures appear (HTTP 401 from the HR system), check that `ACME_CORP_Q3_API_TOKEN` hasn't expired.
5. If Okta reports provisioning errors, pull the Okta System Log (Admin → Reports → System Log → filter by `event_type:application.provision*`) and match `request_id` values to connector logs.
6. If rollback is required, follow the procedure in §3 above.

**Promotion gate status (OKT-60):** `preprod_verified_at` is null — this connector has NOT been promoted to production. Do not route production Okta traffic to it until the promotion gate is fully populated and signed off per Connector Law 10 (AUDIT-TRAIL).