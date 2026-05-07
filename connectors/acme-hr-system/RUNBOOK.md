# RUNBOOK — Acme HR System SCIM Connector (OKT-10)

**Connector:** `acme-hr-system`
**Ticket:** OKT-10
**Target Okta tenant:** `demo-tomato-leopon-10388.oktapreview.com`
**Lifecycle policy:** `soft_delete` — rows are **never deleted**; `enabled:false` is the deactivation signal.
**Source model:** LDAP-shaped (`uid`, `cn`, `givenName`, `sn`, `mail`, `enabled`, `memberOf`)

---

## 1. Environment Variables

| Variable | Purpose | Required? | Format / Notes |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector | **Yes in staging + prod** | ≥ 32 chars, random. Rotate via the secret store (Vault / AWS Secrets Manager). |
| `ACME_HR_API_TOKEN` | Bearer token this connector presents to the Acme HR System API | **Yes in staging + prod** | ≥ 32 chars. Issued by the customer's IAM team. |
| `ACME_HR_BASE_URL` | Base URL of the Acme HR System API | No (defaults to prod) | `https://dev.acme-hr.example.com` (dev), `https://staging.acme-hr.example.com` (staging), `https://api.acme-hr.example.com` (prod) |
| `CONNECTOR_PORT` | TCP port this connector listens on | No (defaults to `3003`) | Integer. Must not collide with other connectors on the same host. |
| `NODE_ENV` | Runtime environment | No | `production` triggers mandatory-token check at startup. Set to `production` in staging + prod deployments. |
| `PROMOTION_SIGNING_KEY_CURRENT` | HMAC key for signing the Promotion Manifest | **Yes at sign/verify time** | ≥ 32 chars. Never set in connector process directly — used only by `scripts/promote.ts`. |
| `PROMOTION_SIGNING_KEY_CURRENT_ID` | Human-readable key ID stamped in the manifest envelope | No (defaults to `current`) | Short string, e.g. `2026-q2`. |

**Dev-mode shortcuts (local only, never in CI or prod):**
- Omit `SCIM_AUTH_TOKEN` → connector accepts all requests without auth.
- Omit `ACME_HR_API_TOKEN` → connector calls the target API without auth header.

---

## 2. Deployment

### Prerequisites

- Node 20+
- `npm ci` completed at repo root
- Network access from the connector host to `ACME_HR_BASE_URL`
- `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` set in the environment (or secret store)

### Local / Dev

```bash
# Start the connector locally (no auth, dev target):
ACME_HR_BASE_URL=https://dev.acme-hr.example.com \
  tsx connectors/acme-hr-system/start.ts
# Logs: JSON line with scim_base_url, target_base_url, auth_configured

# Verify liveness:
curl -sS http://localhost:3003/scim/v2/healthz
# Expected: {"status":"ok","uptime_seconds":N,"version":"dev","target_reachable":true}
```

### Staging

```bash
export NODE_ENV=production
export ACME_HR_BASE_URL=https://staging.acme-hr.example.com
export ACME_HR_API_TOKEN=$(vault kv get -field=value secret/acme-hr-system/staging/api-token)
export SCIM_AUTH_TOKEN=$(vault kv get -field=value secret/acme-hr-system/staging/scim-token)
export CONNECTOR_PORT=3003

tsx connectors/acme-hr-system/start.ts
```

Or via the provided `Dockerfile` (once containerisation is wired in Day 6):

```bash
docker build -t acme-hr-system-connector:latest .
docker run --env-file .env.staging -p 3003:3003 acme-hr-system-connector:latest
```

### Terraform (staging workspace — Day 6)

```bash
cd infra/
terraform workspace select staging
terraform apply -var="connector_image_tag=$(git rev-parse --short HEAD)" -auto-approve
```

Verify the connector is reachable from the internet before pointing Okta at it:

```bash
curl -sS -H "Authorization: Bearer $SCIM_AUTH_TOKEN" \
  https://staging-connector.acme-hr.example.com/scim/v2/ServiceProviderConfig
# Expected: 200 + {"patch":{"supported":true},"filter":{"supported":true},...}
```

### Pointing Okta at the connector

1. In the Okta Admin Console for `demo-tomato-leopon-10388.oktapreview.com`, navigate to **Applications → [Acme HR System app] → Provisioning → Integration**.
2. Set SCIM connector URL to `https://<connector-host>/scim/v2`.
3. Set Authentication Mode to **HTTP Header** and paste `SCIM_AUTH_TOKEN`.
4. Click **Test API Credentials** — must return green.
5. Enable **Import Users**, **Sync Password**, **Push New Users**, **Push Profile Updates**, **Deactivate Users**.
6. Run an import to verify connectivity end-to-end.

---

## 3. Rollback

### If staging verification fails (before promotion)

Do not promote. Fix the ticket, re-generate the connector, and re-run the smoke + OIN replay tests.

```bash
# Re-generate after fixing the ticket:
# (trigger the agent with updated OKT-10 yaml, replace files under connectors/acme-hr-system/)
npm test -- --testPathPattern connectors/acme-hr-system
```

### If production breaks after promotion

**Two-of-two approval required** for production rollback (same gate as forward promotion — Connector Law 10 AUDIT-TRAIL). A unilateral rollback is a security incident.

```bash
# 1. Identify the last-known-good git tag from the prior Promotion Manifest:
jq -r .manifest.git_tag path/to/last-good-manifest.json

# 2. Check out that ref:
git checkout <last-known-good-tag>

# 3. Re-deploy to prod (once Terraform is wired):
cd infra/
terraform workspace select prod
terraform apply -var="connector_image_tag=<last-known-good-tag>" -auto-approve

# 4. Run the smoke test against prod to confirm recovery:
tsx scripts/smoke/cli.ts \
  --connector-url https://prod-connector.acme-hr.example.com \
  --target-url    https://api.acme-hr.example.com
# Expected: exit 0, smoke_test_passed=true
```

---

## 4. Smoke and Verification

Three checks must all pass before marking a deployment healthy.

### 4a. Health probe

```bash
curl -sS http://localhost:3003/scim/v2/healthz
```

**Expected (healthy):**
```json
{"status":"ok","uptime_seconds":12,"version":"dev","target_reachable":true}
```

**Expected (connector alive but target unreachable):** HTTP 503 with `target_reachable: false` and `target_error` detail. This indicates a network or credential issue between the connector and `ACME_HR_BASE_URL` — NOT a connector bug.

### 4b. Full smoke cycle

```bash
tsx scripts/smoke/cli.ts \
  --connector-url http://localhost:3003 \
  --target-url    https://staging.acme-hr.example.com
```

The smoke script:
1. Creates a test user via `POST /scim/v2/Users`
2. Reads it back via `GET /scim/v2/Users/:id`
3. Deactivates it via `PATCH /scim/v2/Users/:id` (`active:false`)
4. Verifies the target API reflects `enabled:false` (not deleted — soft_delete policy)
5. Deletes it via `DELETE /scim/v2/Users/:id` and verifies the row still exists with `enabled:false`
6. Reports pass/fail with full JSON log

**Expected:** `exit 0`, `"smoke_test_passed": true`, `"log_errors_count": 0`.

### 4c. OIN replay test

```bash
npm test -- --testPathPattern replay-test
```

Covers the 12 Required + 1 Optional OIN-gating SPEC tests (okta-dialect.md §12). All 13 must pass.

Key tests this connector must pass:
- **Step 0:** `GET /Users?count=1&startIndex=1` → valid ListResponse
- **Step 10:** `POST /Users` with realistic values → 201 + body
- **Step 14:** Duplicate POST → 409 + `scimType:uniqueness`
- **Step 16:** `userName eq "FOO"` ≠ `userName eq "foo"` (case-sensitive — okta-dialect.md §2)
- **Step 20:** No/bad auth → 401 (bearer token enforcement)

---

## 5. Known Limitations

- **No server-side filter pushdown.** `GET /Users?filter=...` fetches ALL users from the Acme HR System API and filters in memory. For tenants with > 5,000 users this will be slow and may approach memory limits. When the customer's API gains a `/users?filter=` or `/users?q=` endpoint, add pushdown in `store.ts:list()` and update this section.

- **Groups not implemented.** OKT-10 `required_ops` has no group push. The connector does not serve `GET /Groups`, `POST /Groups`, or `PATCH /Groups/:id`. If the customer later requires group push, raise a new ticket — the skeleton has the group router scaffolded.

- **Single `mail` field.** AcmeHR System uses a single scalar `mail` field, not a multi-value email array. SCIM PATCH ops that attempt to add a secondary email (e.g. `op:add, path:emails, value:[{type:"home",...}]`) are handled by extracting only the primary value. Secondary/personal emails are not persisted to the target.

- **`meta.created` is approximate.** The target API does not expose a separate `createdAt` timestamp; `meta.created` is set to `lastModified` (the server-stamp on the most recent mutation). Okta reads `meta.created` for display only; no functional impact is expected.

- **No token rotation automation.** `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` rotation is manual. For production customers, integrate with the secret store rotation workflow before go-live. A rotated token requires a connector restart (env var reload).

- **Single-node deployment.** The connector is stateless (all state lives in the Acme HR System API). Horizontal scaling is safe in principle, but the Terraform scaffold assumes one node. Wire a load balancer target group before scaling out.

- **Reactivation does not re-populate zeroed attributes.** OKT-10 does NOT configure `deactivation_attribute_clearing`, so this limitation does not apply today. If attribute zeroing is added in a future ticket, revisit the reactivation flow per okta-dialect.md §4 (stale-attribute gotcha).

---

## 6. On-Call / Escalation

| Role | Contact | Notes |
|---|---|---|
| **Primary (connector owner)** | File a GitHub issue on this repo + Slack `#scim-connectors` | Tag `OKT-10` and `acme-hr-system` |
| **Secondary (Pro Serve backup)** | Pro Serve rotation lead — confirm before staging go-live | Assign in the ticket before cutover |
| **P0 — production auth broken** | PagerDuty rotation (Pro Serve) | Page immediately; do not wait for business hours |
| **Customer escalation path** | Acme HR System IAM team contact — to be filled in by account owner before prod | Token issues and API-side errors require their involvement |

### SLA targets (production customers — not binding for hackathon)

| Priority | Definition | Response target |
|---|---|---|
| P0 | Production auth broken; no users can provision | 30 minutes |
| P1 | Provisioning degraded; some users failing | 4 hours |
| P2 | Non-blocking issue; workaround available | 1 business day |

### Triage checklist

Before paging:

1. Check `/healthz` — is `target_reachable: true`? If false, the issue is between the connector and `ACME_HR_BASE_URL`, not in the connector itself. Engage the Acme HR System IAM team.
2. Check the connector logs (structured JSON, filter by `request_id` from the Okta error). Look for `"status":401` (expired `SCIM_AUTH_TOKEN`), `"status":409` (unexpected uid collisions), or `"status":500` (connector bugs).
3. Run the smoke test. If `smoke_test_passed: false`, the connector is the likely culprit.
4. If the smoke test passes but Okta still reports errors, capture the Okta System Log event and attach to the incident ticket — the `request_id` header correlates connector logs to Okta events.