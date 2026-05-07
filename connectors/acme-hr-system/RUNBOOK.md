# RUNBOOK — Acme HR System SCIM Connector

**Ticket:** OKT-10  
**Customer app:** Acme HR System  
**Lifecycle policy:** `soft_delete` — user rows are never physically deleted; deactivation sets `enabled: false` and retains the row for audit  
**Target Okta tenant:** `demo-tomato-leopon-10388.oktapreview.com`  
**Terraform workspace:** `staging`  
**SCIM base path:** `https://<connector-host>/scim/v2`

---

## 1. Environment Variables

All credentials are injected via environment variables. No credentials in source code or config files (Connector Law 4 SECRETS-OUT).

| Variable | Purpose | Required in prod? | Default | Notes |
|---|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this SCIM connector on every request | **Yes** | None (auth disabled in dev) | ≥ 32 random chars. Generate with `openssl rand -hex 32`. Rotate on compromise. |
| `ACME_HR_API_TOKEN` | Bearer token this connector presents to the Acme HR System native API | **Yes** | None (unauthenticated in dev) | Issued by the Acme HR System admin. Matches `auth_credential_env_var` in OKT-10 ticket. |
| `ACME_HR_BASE_URL` | Base URL of the Acme HR System native API | No | `https://api.acme-hr.example.com` | Switch per environment (see table below). |
| `CONNECTOR_PORT` | TCP port the SCIM connector listens on | No | `3003` | Change if port collides with another service. |
| `PROMOTION_SIGNING_KEY_CURRENT` | HMAC key for Promotion Manifest signing/verification (Connector Law 10 AUDIT-TRAIL) | Yes on sign/verify | None | ≥ 32 chars. Shared with the CI promotion gate. |
| `PROMOTION_SIGNING_KEY_CURRENT_ID` | Human-readable key identifier stamped into the manifest envelope | No | `current` | Short string, e.g. `2026-q2`. |

### Per-environment base URLs (ticket OKT-10 `environments`)

| Environment | `ACME_HR_BASE_URL` |
|---|---|
| dev | `https://dev.acme-hr.example.com` |
| staging | `https://staging.acme-hr.example.com` |
| prod | `https://api.acme-hr.example.com` |

---

## 2. Deployment

### Prerequisites

- Node.js 20+ installed (`node --version` ≥ 20.0.0)
- `npm ci` completed at repo root
- Acme HR System native API reachable at `ACME_HR_BASE_URL`
- Both `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` set in the environment (or in the deployment secrets store)

### Local / dev startup

```bash
# Set environment variables
export ACME_HR_BASE_URL=https://dev.acme-hr.example.com
export ACME_HR_API_TOKEN=<dev-token-from-acme-hr-admin>
export SCIM_AUTH_TOKEN=<any-random-string-for-dev>
export CONNECTOR_PORT=3003

# Start the connector
npx tsx connectors/acme-hr-system/start.ts
# Expected log line (JSON):
# {"level":"info","message":"Acme HR System SCIM connector started","port":3003,...}
```

### Verify the connector is alive

```bash
# Health check (no auth required — okta-dialect.md §9 exempts /healthz)
curl -sS http://localhost:3003/scim/v2/healthz | jq .
# Expected (native API reachable):
# {"status":"ok","uptime_seconds":N,"version":"dev","target_reachable":true}
#
# Expected (native API unreachable):
# HTTP 503 {"status":"degraded","target_reachable":false,"target_error":"..."}
```

```bash
# Smoke create — POST a user through the SCIM layer
curl -sS -X POST http://localhost:3003/scim/v2/Users \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{
    "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
    "userName": "jsmith",
    "name": {"givenName": "Jane", "familyName": "Smith", "formatted": "Jane Smith"},
    "emails": [{"value": "jsmith@acme-hr.example.com", "primary": true, "type": "work"}],
    "active": true
  }' | jq .
# Expected: HTTP 201 with id, userName, active: true
```

### Staging / production (Terraform)

```bash
# Select workspace matching ticket OKT-10 terraform_workspace: staging
terraform workspace select staging

# Apply — ensure environment secrets are injected via your secrets manager
# (Vault / AWS Secrets Manager / Azure Key Vault) before apply.
terraform apply -auto-approve

# Verify health after deploy
curl -sS https://<staging-connector-host>/scim/v2/healthz | jq .
```

For production promotion, the Promotion Manifest gate (Connector Law 10) requires `preprod_verified_at` and `approver_github_username` to be set in the ticket before `terraform workspace select prod && terraform apply`. A unilateral prod apply without the manifest is a security incident.

---

## 3. Rollback

### Identifying the last known good version

```bash
# The Promotion Manifest from the last successful prod deploy contains the git tag.
jq -r '.manifest.git_tag' last-good-manifest.json
# Example output: v1.0.0-acme-hr-system
```

### Rollback procedure

```bash
# 1. Check out the last known good tag
git checkout <last-known-good-tag>

# 2. Rebuild (if compiled)
npm ci && npm run build

# 3. Re-apply prod Terraform
terraform workspace select prod
terraform apply -auto-approve

# 4. Confirm health
curl -sS https://<prod-connector-host>/scim/v2/healthz | jq .

# 5. Run smoke against prod to confirm provisioning still works
tsx scripts/smoke/cli.ts \
  --connector-url https://<prod-connector-host> \
  --target-url    https://api.acme-hr.example.com
```

**Blast-radius note:** a prod rollback requires the same two-of-two approval as a forward promotion (Connector Law 10 AUDIT-TRAIL). A unilateral rollback is a security incident, not a recovery procedure.

If rollback is not possible (e.g. the schema has migrated forward), disable the Okta SCIM provisioning integration from the Okta admin console to halt further sync operations while the incident is triaged. This prevents Okta from sending additional PATCH/POST requests to a broken connector.

---

## 4. Smoke Verification

Three checks must all pass before a deploy is considered healthy:

### Check 1 — Health probe

```bash
curl -sS https://<connector-host>/scim/v2/healthz | jq .
# Must return: {"status":"ok","target_reachable":true,...}
# Failure: HTTP 503 means the connector cannot reach the Acme HR System API.
```

### Check 2 — Full smoke cycle (provision + deactivate + verify)

```bash
tsx scripts/smoke/cli.ts \
  --connector-url https://<connector-host> \
  --target-url    https://api.acme-hr.example.com
# Must exit 0 with smoke_test_passed: true, log_errors_count: 0
# This exercises: create user → filter by userName → PATCH active: false
# → verify native API shows enabled: false (soft_delete policy).
```

### Check 3 — OIN replay tests

```bash
npm run test:replay -- --connector-url https://<connector-host>
# Must pass all 12 required OIN-gating tests:
# Steps 0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 22 per okta-dialect.md §12.
```

### Check 4 — Soft-delete end-to-end (specific to OKT-10)

Soft-delete policy requires verification that both code paths converge:

```bash
# Create a user
USER_ID=$(curl -sS -X POST https://<connector-host>/scim/v2/Users \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"softdel-test","emails":[{"value":"s@example.com","primary":true}],"active":true}' \
  | jq -r .id)

# Deactivate via SCIM PATCH (the normal Okta path — okta-dialect.md §3)
curl -sS -X PATCH "https://<connector-host>/scim/v2/Users/$USER_ID" \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","value":{"active":false}}]}' \
  | jq .active
# Expected: false

# Verify row is RETAINED (not deleted) on the native API
curl -sS "https://api.acme-hr.example.com/users/$USER_ID" \
  -H "Authorization: Bearer $ACME_HR_API_TOKEN" | jq .enabled
# Expected: false (row present, enabled: false)

# Deactivate via SCIM DELETE (the edge-case path — should converge on same state)
USER_ID2=$(curl -sS -X POST https://<connector-host>/scim/v2/Users \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"softdel-test-2","emails":[{"value":"s2@example.com","primary":true}],"active":true}' \
  | jq -r .id)

curl -sS -X DELETE "https://<connector-host>/scim/v2/Users/$USER_ID2" \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN" -w "%{http_code}"
# Expected: 204

curl -sS "https://api.acme-hr.example.com/users/$USER_ID2" \
  -H "Authorization: Bearer $ACME_HR_API_TOKEN" | jq .enabled
# Expected: false (row retained, not deleted — soft_delete policy)
```

---

## 5. Known Limitations

### Filter pushdown is absent

`GET /Users?filter=...` fetches **all** users from the Acme HR System API and filters in-memory inside the connector. This is correct and OIN-compliant, but slow for large user populations.

- **Impact:** full imports (`GET /Users` during initial Okta provisioning) load the entire user set into connector memory. For Acme HR System deployments with > 10,000 users, latency will increase and memory usage may spike.
- **Mitigation:** if Acme HR System ever adds a native SCIM or SQL-filter endpoint, update `store.ts list()` to push the filter down to the API instead of fetching all users. The mapping and client layers do not need to change.

### Groups not in scope

Ticket OKT-10 `required_ops` does not include groups. The SCIM connector does not expose `/scim/v2/Groups` endpoints. Okta's group push feature will not work with this connector until groups are added.

- **Impact:** Okta application assignments can be user-level only. Group-based access cannot be pushed to Acme HR System via this connector.
- **Mitigation:** a follow-on ticket can add `GET /Groups`, `POST /Groups`, `GET /Groups/:id`, `PATCH /Groups/:id` routes and a corresponding `GroupStore` implementation. The skeleton's meta router already advertises groups in `/ResourceTypes`.

### In-memory filtering has no server-side sort

The SCIM spec's `sortBy` / `sortOrder` parameters are not supported. `ServiceProviderConfig` advertises `sort.supported: false`. Okta does not currently emit sort parameters, so this is not a practical limitation.

### Reactivation requires a full profile re-push

If attribute zeroing is configured in future (ticket OKT-10 does not enable it — `deactivation_attribute_clearing` is not set), reactivating a user whose attributes were zeroed on deactivation will return a user with an empty profile until Okta re-pushes attributes. See `okta-dialect.md §4` and `§6` for the full reactivation tension. Current soft_delete policy retains all attributes on `enabled: false`, so this is not an issue today.

### Single-node deployment only

The connector is stateless — all state lives in the native Acme HR System API. Horizontal scaling is supported by design. However the current Terraform scaffold assumes a single node. Multi-node load balancing is a deployment-shape change with no code changes needed.

### `meta.created` is approximated

Acme HR System does not expose a separate user creation timestamp. The connector sets `meta.created` equal to `meta.lastModified`. If Okta or a downstream consumer relies on `meta.created` for audit ordering, the value may be misleading for long-lived user accounts. A schema migration to add a `createdAt` field to the native API would resolve this.

---

## 6. On-Call / Escalation

### Contacts

| Role | Contact | Availability |
|---|---|---|
| Primary — connector owner (Pro Serve) | Slack: `#okta-proserve` DM to connector owner | Business hours (Mon–Fri 09:00–18:00 local) |
| Secondary — Pro Serve backup | Slack: `#okta-proserve` channel | Business hours |
| Tertiary — Acme HR System API owner | Contact via customer-provided escalation path | Per customer SLA |
| P0 production auth broken | PagerDuty rotation `okta-proserve-oncall` | 24×7 once customer goes live in production |

### Incident severity & response targets

| Severity | Definition | Response target | Action |
|---|---|---|---|
| **P0** | Production Okta provisioning completely broken (auth failure, 5xx on all endpoints, mass deprovisioning) | 30 minutes | Page on-call immediately; disable Okta SCIM sync from Okta admin console to halt damage; begin rollback procedure |
| **P1** | Partial provisioning broken (some users not syncing, deactivation failing) | 4 hours | Investigate logs via request-id correlation; patch and re-deploy |
| **P2** | Performance degradation (slow imports, timeouts on large filter requests) | 1 business day | Review filter pushdown limitation; consider caching or pagination tuning |
| **P3** | Non-blocking issues (cosmetic, missing optional attributes) | Next sprint | File a follow-on ticket |

### Diagnostic first steps

```bash
# 1. Check health — is the connector up and can it reach the native API?
curl -sS https://<connector-host>/scim/v2/healthz | jq .

# 2. Check recent logs — filter by request_id for a specific failing request.
# (Log destination depends on deployment — CloudWatch, stdout, etc.)
# Look for: level=error, scimType, status >= 400.

# 3. Test auth independently — confirm Okta's bearer token is accepted.
curl -sS -o /dev/null -w "%{http_code}" \
  https://<connector-host>/scim/v2/Users \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN"
# Expected: 200. If 401: SCIM_AUTH_TOKEN mismatch.

# 4. Test native API reachability from the connector host.
curl -sS -o /dev/null -w "%{http_code}" \
  https://api.acme-hr.example.com/users \
  -H "Authorization: Bearer $ACME_HR_API_TOKEN"
# Expected: 200. If 401/403: ACME_HR_API_TOKEN expired or revoked.
# If timeout/5xx: native API outage — escalate to Acme HR System team.

# 5. Replay OIN tests against the live connector to narrow which step fails.
npm run test:replay -- --connector-url https://<connector-host>
```

### Token rotation procedure

When rotating `SCIM_AUTH_TOKEN` or `ACME_HR_API_TOKEN`:

1. Generate a new token: `openssl rand -hex 32`
2. Update the secret in your secrets manager (Vault / AWS Secrets Manager / etc.)
3. For `SCIM_AUTH_TOKEN`: **also update the token in the Okta app provisioning settings** (Okta admin console → Applications → Acme HR System → Provisioning → Integration → Edit → API token). Okta will start using the new token immediately.
4. For `ACME_HR_API_TOKEN`: coordinate with the Acme HR System API admin.
5. Re-deploy the connector with the new environment variable.
6. Verify health and run smoke immediately after rotation.
7. Old token should be revoked only after smoke passes — do not revoke before the new token is confirmed working.