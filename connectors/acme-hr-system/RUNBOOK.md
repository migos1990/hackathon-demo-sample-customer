# RUNBOOK — Acme HR System SCIM Connector

**Ticket:** OKT-10
**Customer slug:** `acme-hr-system`
**Okta tenant:** `demo-tomato-leopon-10388.oktapreview.com`
**Lifecycle policy:** `soft_delete` — rows are NEVER physically removed from Acme HR System.
**Native API shape:** LDAP-flavored REST (uid / cn / givenName / sn / mail / enabled / memberOf).
**Auth:** Bearer token both directions (Okta → connector via `SCIM_AUTH_TOKEN`; connector → Acme HR System via `ACME_HR_API_TOKEN`).

---

## 1. Environment Variables

| Variable | Purpose | Required? | Format / Notes |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector | **Yes in prod** | ≥32 chars, random. Omit only in dev-mode for local iteration — connector logs a loud warning when absent. |
| `ACME_HR_API_TOKEN` | Bearer token this connector presents to Acme HR System | **Yes in prod** | ≥32 chars. Set per environment. OKT-10 `auth_credential_env_var`. |
| `ACME_HR_SYSTEM_BASE_URL` | Base URL of the Acme HR System REST API | No (defaults to prod) | See table below. Override for dev/staging. |
| `CONNECTOR_PORT` | TCP port the connector listens on | No | Integer, default `3003`. |

### Base URL per environment

| Environment | URL |
|---|---|
| dev | `https://dev.acme-hr.example.com` |
| staging | `https://staging.acme-hr.example.com` |
| prod | `https://api.acme-hr.example.com` |

Set `ACME_HR_SYSTEM_BASE_URL` to the appropriate value. The binary defaults to prod if the variable is unset.

### Minimal prod `.env` (never commit to git)

```dotenv
SCIM_AUTH_TOKEN=<random-32-chars>
ACME_HR_API_TOKEN=<acme-hr-system-api-token>
ACME_HR_SYSTEM_BASE_URL=https://api.acme-hr.example.com
CONNECTOR_PORT=3003
```

---

## 2. Deployment

### Prerequisites

- Node 20+
- `npm ci` completed at repo root
- Acme HR System API reachable at `ACME_HR_SYSTEM_BASE_URL`
- Okta SCIM provisioning app configured with:
  - SCIM base URL: `https://<connector-host>:3003/scim/v2`
  - Authentication: Bearer, value = `SCIM_AUTH_TOKEN`

### Start the connector

```bash
# With env vars from a .env file (use dotenv-cli or export manually):
SCIM_AUTH_TOKEN=xxx ACME_HR_API_TOKEN=yyy ACME_HR_SYSTEM_BASE_URL=https://staging.acme-hr.example.com \
  npx tsx connectors/acme-hr-system/start.ts

# Or via package.json script (add this entry):
# "start:acme-hr-system-connector": "tsx connectors/acme-hr-system/start.ts"
npm run start:acme-hr-system-connector
```

Expected startup log (structured JSON):

```json
{
  "level": "info",
  "msg": "Acme HR System SCIM connector started",
  "port": 3003,
  "scim_base": "http://localhost:3003/scim/v2",
  "target_base_url": "https://staging.acme-hr.example.com",
  "auth_enabled": true,
  "target_auth_enabled": true,
  "lifecycle_policy": "soft_delete",
  "ticket": "OKT-10"
}
```

### Verify connectivity

```bash
# 1. Health check (no auth required — load balancer safe)
curl -sS http://localhost:3003/scim/v2/healthz
# Healthy: {"status":"ok","uptime_seconds":N,"version":"dev","target_reachable":true}
# Degraded: HTTP 503, {"status":"error","target_error":"..."}

# 2. ServiceProviderConfig (no auth by default — SCIM convention)
curl -sS http://localhost:3003/scim/v2/ServiceProviderConfig | jq .

# 3. Create a test user
curl -sS -X POST http://localhost:3003/scim/v2/Users \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{
    "schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],
    "userName":"runbook-test",
    "name":{"givenName":"Runbook","familyName":"Test"},
    "emails":[{"value":"runbook@acme-hr.example.com","primary":true,"type":"work"}],
    "active":true
  }'
# Expected: 201 + body with id="runbook-test"

# 4. Deactivate the test user (primary Okta lifecycle path)
curl -sS -X PATCH http://localhost:3003/scim/v2/Users/runbook-test \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{
    "schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    "Operations":[{"op":"replace","value":{"active":false}}]
  }'
# Expected: 200 + body with active=false

# 5. Verify soft-delete via DELETE
curl -sS -X DELETE http://localhost:3003/scim/v2/Users/runbook-test \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN"
# Expected: 204 No Content

# 6. Confirm row retained in Acme HR System with enabled=false (not removed)
curl -sS https://api.acme-hr.example.com/users/runbook-test \
  -H "Authorization: Bearer $ACME_HR_API_TOKEN" | jq .enabled
# Expected: false  (row exists, enabled=false — soft delete confirmed)
```

### Terraform (staging workspace — OKT-10 `terraform_workspace: "staging"`)

```bash
terraform workspace select staging
terraform apply -auto-approve
# After apply, run smoke (§4) against the deployed URL.
```

---

## 3. Rollback

### If staging fails the verification gate

Do NOT promote. Fix the root cause, re-generate, re-run smoke.

```bash
# 1. Identify failing test step from smoke output or CI logs.
# 2. Fix mapping.ts / client.ts / store.ts as required.
# 3. Run unit tests to confirm the fix.
npm test -- --testPathPattern connectors/acme-hr-system
# 4. Re-run smoke against staging.
tsx scripts/smoke/cli.ts \
  --connector-url https://staging-connector.acme-hr.example.com \
  --target-url    https://staging.acme-hr.example.com
# 5. Only promote if smoke_test_passed=true, log_errors_count=0.
```

### If production goes sideways after promotion

```bash
# 1. Identify the last-known-good git tag from the prior Promotion Manifest.
jq -r .manifest.git_tag last-good-manifest.json

# 2. Check out that ref.
git checkout <last-known-good-tag>

# 3. Re-apply prod via Terraform.
terraform workspace select prod
terraform apply -auto-approve

# 4. Re-run smoke against prod to confirm recovery.
tsx scripts/smoke/cli.ts \
  --connector-url https://connector.acme-hr.example.com \
  --target-url    https://api.acme-hr.example.com

# 5. File an incident ticket with the root cause before re-promoting.
```

**Blast-radius note:** production rollback requires the same two-of-two approval as a forward promotion (Connector Law 10 AUDIT-TRAIL). A unilateral rollback is a security incident.

---

## 4. Smoke + Verification

Three checks must all pass before promoting to production.

```bash
# 1. Liveness + target reachability
curl -sS http://localhost:3003/scim/v2/healthz
# Required: {"status":"ok","target_reachable":true}

# 2. Full smoke cycle (provision → deactivate → verify target reflects deactivation)
tsx scripts/smoke/cli.ts \
  --connector-url http://localhost:3003 \
  --target-url    https://staging.acme-hr.example.com
# Required: exit 0, smoke_test_passed=true, log_errors_count=0

# 3. OIN test-suite replay (mirrors the 13 OIN-gating tests)
#    okta-dialect.md §12 — these are the tests that determine OIN acceptance.
tsx replay-test/replay.test.ts \
  --connector-url http://localhost:3003 \
  --auth-token    $SCIM_AUTH_TOKEN
# Required: all 13 steps pass (including step 16 case-sensitivity check,
#           step 14 duplicate-create 409, step 20 auth-failure 401)
```

The smoke cycle validates:

1. `POST /Users` → 201, id returned, user visible in Acme HR System with `enabled=true`
2. `PATCH /Users/{id}` with `active:false` → 200, `enabled=false` in Acme HR System (soft-delete path)
3. `DELETE /Users/{id}` → 204, `enabled=false` in Acme HR System (row retained — soft-delete confirmed)
4. `GET /Users/{id}` for deactivated user → 200, `active:false` in SCIM response
5. `GET /Users?filter=userName eq "..."` → ListResponse with exactly one matching resource (case-sensitive)

---

## 5. Known Limitations

- **Filter pushdown is absent.** `GET /Users?filter=...` fetches ALL Acme HR System users and filters in-memory. For directories exceeding ~5,000 users this will be slow and may hit memory limits. Mitigation: push filter queries down to Acme HR System's native API if it supports them (requires `client.ts` changes to pass query params). Track as a follow-up ticket.

- **`meta.created` is approximated as `meta.lastModified`.** Acme HR System does not expose a separate `createdAt` timestamp. Both SCIM `meta.created` and `meta.lastModified` are populated from the native `lastModified` field. If creation timestamp accuracy matters for downstream Okta attribute mappings, request a `createdAt` field from the Acme HR System API team.

- **Groups not implemented.** OKT-10 `required_ops` does not include `groups_create`, `groups_update`, or `groups_delete`. Group push is not wired. If Okta group push is enabled on the provisioning app, group operations will return 404. File a follow-up ticket to add `/Groups` routes if group push is required.

- **Single-node only.** The connector is stateless (all state lives in Acme HR System's API) — horizontal scaling is safe in principle, but the Terraform scaffold assumes one node. Multi-node deployment is untested.

- **In-memory filtering only.** Complex SCIM filters beyond `eq` (e.g. `co`, `sw`, `gt`, temporal `meta.lastModified gt "..."`) are forwarded to `scim2-parse-filter` for in-memory evaluation. This works correctly but requires fetching all users first. See filter-pushdown limitation above.

- **Single-token names (Madonna case).** Users with `sn: null` have `name.familyName` omitted from SCIM responses. Some downstream systems that require `name.familyName` will surface an error. This is correct SCIM behavior (RFC 7643 — familyName is not required) but may need a placeholder if the customer's Okta profile mappings treat familyName as required.

- **Bearer token rotation is manual.** `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` rotation requires restarting the connector process. Zero-downtime key rotation is not implemented.

---

## 6. On-Call / Escalation

| Role | Contact | Availability |
|---|---|---|
| **Primary (connector owner)** | Pro Serve lead assigned to OKT-10 — check Linear ticket for assignee | Business hours |
| **Secondary (Pro Serve backup)** | Pro Serve on-call rotation (see PagerDuty `pro-serve` schedule) | Business hours |
| **P0 escalation (Okta provisioning down in prod)** | PagerDuty `pro-serve-p0` — 24×7 once customer goes live in prod |
| **Acme HR System API issues** | Acme HR System API team — contact via customer's Slack channel (see Linear OKT-10 for channel link) | Per customer SLA |

### Incident severity + response targets

| Severity | Definition | Response target |
|---|---|---|
| **P0** | Okta cannot provision / deprovision users; customer production blocked | 30 minutes |
| **P1** | Partial provisioning failures; some users affected; workaround available | 4 hours |
| **P2** | Non-critical degradation (e.g. slow imports, non-blocking warnings) | 1 business day |
| **P3** | Cosmetic / documentation issues | Next sprint |

### Common triage steps

```bash
# Is the connector alive?
curl -sS https://<connector-host>/scim/v2/healthz

# Is Acme HR System reachable? (target_reachable: false → network/auth issue)
# Check ACME_HR_API_TOKEN is set and valid.

# Are SCIM requests getting through? Check connector logs for request-id correlation.
# Every request emits a JSON log line with x-request-id — find the failing request.

# Is auth failing? (OIN step 20)
# Confirm SCIM_AUTH_TOKEN in Okta provisioning app matches the connector's env var.
# curl -sS http://<host>/scim/v2/Users -H "Authorization: Bearer wrongtoken"
# Expected: 401 with SCIM Error envelope — not an HTML 401 page.

# Is this a soft-delete policy question?
# Confirm: after DELETE /Users/{id}, the user row exists in Acme HR System
# with enabled=false. If the row is missing, the Acme HR System API team
# may have changed the DELETE behavior on their side.
```

### Promotion gate status (OKT-10)

The `promotion_gate` block in the ticket is currently unpopulated:

```yaml
promotion_gate:
  preprod_verified_at: null
  preprod_manifest_sha: null
  approver_github_username: null
  promoted_to_prod_at: null
```

This connector MUST NOT be pointed at the prod Okta tenant until:

1. `preprod_verified_at` is stamped (smoke + OIN replay both pass on staging)
2. `preprod_manifest_sha` records the git commit SHA of the generated output
3. `approver_github_username` has a valid Pro Serve approver
4. Two-of-two approval obtained per Connector Law 10 AUDIT-TRAIL

Update the Linear ticket OKT-10 with these values before prod cutover.