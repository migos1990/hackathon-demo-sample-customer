# RUNBOOK — AcmeCorpQ3 SCIM Connector

**Ticket:** OKT-57
**Customer:** Custom SCIM Connector for Internal HR System
**Slug:** `acme-corp-q3`
**Lifecycle policy:** `soft_delete` — users are **never hard-deleted**; deactivation sets `enabled=false` on the native API.
**OIN target tenant:** `demo-tomato-leopon-10388.oktapreview.com`
**Terraform workspace:** `staging`

---

## 1. Environment variables

All secrets are injected via environment variables. **No tokens appear in source code** (Connector Law 4 SECRETS-OUT).

| Variable | Purpose | Required in prod? | Format / notes |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta must present to this connector's SCIM endpoints. Missing → unauthenticated (dev only). OIN step 20 asserts 401 on bad/missing auth (`docs/okta-dialect.md §9`). | **Yes** | ≥ 32 random chars, no whitespace |
| `ACME_CORP_Q3_API_TOKEN` | Bearer token this connector presents to the AcmeCorpQ3 native HR API. OKT-57 `auth_credential_env_var`. | **Yes** | Issued by the AcmeCorpQ3 HR team |
| `ACME_CORP_Q3_BASE_URL` | Override the native API base URL. Defaults: dev → `https://api.dev.acme-corp-q3.example.com`, prod → `https://api.acme-corp-q3.example.com` (OKT-57 `base_url` / `environments.dev`). | No | HTTPS URL, no trailing slash |
| `CONNECTOR_PORT` | TCP port the connector listens on. Default: `3003`. | No | Integer 1–65535 |
| `NODE_ENV` | Set to `production` in prod deployments to activate the prod base URL default and suppress dev-mode warnings. | Recommended | `production` \| `development` |

### Setting variables for local dev

```bash
export SCIM_AUTH_TOKEN="dev-scim-token-replace-in-prod"
export ACME_CORP_Q3_API_TOKEN="dev-native-token-replace-in-prod"
export ACME_CORP_Q3_BASE_URL="https://api.dev.acme-corp-q3.example.com"
export CONNECTOR_PORT=3003
```

For staging/prod, variables are managed via Terraform secrets + the deployment pipeline. Do **not** commit real tokens.

---

## 2. Deployment

### Prerequisites

- Node.js 20 or later
- `npm ci` completed at repo root
- AcmeCorpQ3 HR API reachable at `ACME_CORP_Q3_BASE_URL`
- `SCIM_AUTH_TOKEN` and `ACME_CORP_Q3_API_TOKEN` set in the environment

### Start the connector (local / dev)

```bash
# From repo root:
SCIM_AUTH_TOKEN="dev-token" \
ACME_CORP_Q3_API_TOKEN="native-dev-token" \
ACME_CORP_Q3_BASE_URL="https://api.dev.acme-corp-q3.example.com" \
tsx connectors/acme-corp-q3/start.ts
# Expected log: {"level":"info","msg":"AcmeCorpQ3 SCIM connector listening","url":"http://localhost:3003/scim/v2",...}
```

### Verify the connector is up

```bash
# Health check (no auth required):
curl -sS http://localhost:3003/scim/v2/healthz
# Expected: {"status":"ok","uptime_seconds":N,"version":"dev","target_reachable":true}

# ServiceProviderConfig (confirms PATCH + filter enabled):
curl -sS http://localhost:3003/scim/v2/ServiceProviderConfig | jq '{patch,filter}'
# Expected: {"patch":{"supported":true},"filter":{"supported":true,"maxResults":200}}
```

### Staging deploy (Terraform)

```bash
# Ensure the Terraform workspace matches OKT-57 terraform_workspace: staging
terraform workspace select staging
terraform apply -auto-approve
# Outputs include the connector URL — update Okta app SCIM provisioning URL to match.
```

### Connecting to Okta

1. In the Okta Admin Console, open the app provisioning settings for the AcmeCorpQ3 integration.
2. Set the **SCIM connector base URL** to the connector's public URL + `/scim/v2`
   (e.g. `https://scim.acme-corp-q3.staging.example.com/scim/v2`).
3. Set the **authentication method** to `HTTP Header` and paste the value of `SCIM_AUTH_TOKEN`.
4. Click **Test Connector Configuration** — Okta will hit `GET /Users?count=1&startIndex=1` (OIN step 0).
5. Enable provisioning features: **Create Users**, **Update User Attributes**, **Deactivate Users**.
   (Groups are not enabled for this ticket — see Limitations.)

---

## 3. Rollback

### If staging fails the verify gate

Do **not** promote. Fix the issue, re-run the smoke test, re-verify.

```bash
# Re-run smoke to confirm the regression:
tsx scripts/smoke/cli.ts \
  --connector-url https://scim.acme-corp-q3.staging.example.com \
  --target-url    https://api.dev.acme-corp-q3.example.com
```

### If prod goes wrong after promotion

1. **Identify the last-known-good commit** from the prior Promotion Manifest:

   ```bash
   jq -r .manifest.git_tag last-good-manifest.json
   ```

2. **Check out that ref:**

   ```bash
   git checkout <last-known-good-tag>
   ```

3. **Re-apply Terraform** (once Day 6 Terraform wiring lands):

   ```bash
   terraform workspace select staging   # or prod when available
   terraform apply -auto-approve
   ```

4. **Re-run smoke** to confirm the rollback is stable:

   ```bash
   tsx scripts/smoke/cli.ts \
     --connector-url <connector-url> \
     --target-url    <target-url>
   ```

5. **File a post-mortem** and open a new Linear ticket for the root cause.

> **Blast-radius note:** a prod rollback requires the same two-approver sign-off as a forward promotion (Connector Law 10 AUDIT-TRAIL). A unilateral rollback is a security incident.

---

## 4. Smoke + verification

Three checks must all pass before any promotion gate can be marked satisfied.

### 4a. Health probe

```bash
curl -sS http://localhost:3003/scim/v2/healthz
```

**Healthy:** `{"status":"ok","target_reachable":true,...}`
**Degraded (target unreachable):** HTTP 503 with `target_error` detail in body.

### 4b. Full smoke cycle

```bash
tsx scripts/smoke/cli.ts \
  --connector-url http://localhost:3003 \
  --target-url    https://api.dev.acme-corp-q3.example.com
```

The smoke script:
1. Creates a user via SCIM POST → verifies the user appears in native API (`enabled=true`).
2. Deactivates the user via SCIM PATCH `active=false` → verifies native API shows `enabled=false` (**not deleted** — soft-delete, `docs/okta-dialect.md §3`).
3. Reactivates the user via SCIM PATCH `active=true` → verifies `enabled=true`.
4. Verifies GET by ID returns the correct user before and after each state change.
5. Verifies LIST with `filter=userName eq "<uid>"` returns exactly one result (OIN step 4 / 8).

**Expected:** exit 0, `smoke_test_passed: true`, `log_errors_count: 0`.

### 4c. OIN spec test replay

```bash
tsx replay-test/replay.test.ts --slug acme-corp-q3
```

Covers OIN-gating tests 0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 22 (all Required tests). Must be 12/12 green. `docs/okta-dialect.md §12`.

### 4d. Soft-delete verification (critical for lifecycle_policy=soft_delete)

```bash
# After the smoke deactivation step, confirm the row still exists in native API:
curl -sS -H "Authorization: Bearer $ACME_CORP_Q3_API_TOKEN" \
  "https://api.dev.acme-corp-q3.example.com/users/<smoke-user-uid>" \
  | jq '{uid, enabled}'
# Expected: {"uid":"<uid>","enabled":false}  ← row exists, enabled=false
# WRONG:    404  ← would mean hard-delete happened (policy violation)
```

---

## 5. Known limitations

- **Groups not implemented.** OKT-57 `required_ops` does not include groups (`users_create`, `users_read`, `users_update_patch`, `users_delete`, `users_list`, `users_filter` only). The connector does not mount `/Groups` routes. If the customer later needs group push, a follow-up ticket is required.

- **In-memory filter only.** `GET /Users?filter=...` fetches all users from the native API and filters in memory. AcmeCorpQ3 has no server-side SCIM filter API. For user populations exceeding ~5,000 users, list performance will degrade. A follow-up ticket should add filter pushdown once the native API supports query parameters.

- **No cursor pagination.** Pagination follows RFC 7644 `startIndex`/`count` (offset-based). Concurrent writes between pages can cause missed or duplicate results in large imports. This is a known limitation of offset pagination (`docs/okta-dialect.md §7`).

- **meta.created is approximate.** The native API does not expose a separate creation timestamp. `meta.created` is set to `lastModified` at mapping time. This affects the accuracy of creation-date display in Okta's UI but does not affect provisioning correctness.

- **No attribute zeroing on deactivation.** OKT-57 does not configure `deactivation_attribute_clearing`. Deactivation sets `enabled=false` only — all other attributes (email, name, department) are retained on the native API. If GDPR data-minimisation requirements arise, a follow-up ticket must add the clearing list and the reactivation re-population flow (`docs/okta-dialect.md §6`).

- **Single-node only.** The connector is stateless — it holds no local user state — but the native API is the single point of truth. Horizontal scaling is safe in principle; the Terraform scaffold currently assumes one node. Scale-out requires the customer's ops team to front the connector with a load balancer.

- **No key rotation automation.** `SCIM_AUTH_TOKEN` and `ACME_CORP_Q3_API_TOKEN` rotation is manual. Coordinate with the AcmeCorpQ3 team and update Okta's app config atomically when rotating.

---

## 6. On-call / escalation

| Role | Contact | Coverage |
|---|---|---|
| **Primary (connector owner)** | Okta Professional Services — file via the Linear board (OKT-*) | Business hours; P0 paging TBD before prod cutover |
| **Secondary (Pro Serve backup)** | Assign in the Linear ticket before go-live | Same coverage |
| **Customer HR system team** | Via the AcmeCorpQ3 internal Slack channel (to be confirmed by customer) | For native API issues |
| **Okta support** | https://support.okta.com | For Okta-side provisioning / tenant issues |

### Incident severity guide

| Severity | Definition | Target response |
|---|---|---|
| **P0** | Okta cannot provision any users; all creates/patches failing; production auth broken | 30 minutes (requires on-call rotation before prod go-live) |
| **P1** | Partial provisioning failure; a subset of users affected; deactivation not propagating | 4 hours |
| **P2** | Non-critical attribute mapping issue; cosmetic discrepancies in Okta profile | 1 business day |

> **Note:** These targets are aspirational for the staging phase. Binding SLAs require a signed PS SOW before the customer moves to production.

### Useful diagnostic commands

```bash
# Is the connector alive and can it reach the native API?
curl -sS <connector-url>/scim/v2/healthz | jq .

# What does Okta see when it hits the user list?
curl -sS -H "Authorization: Bearer $SCIM_AUTH_TOKEN" \
  "<connector-url>/scim/v2/Users?count=5&startIndex=1" | jq '{totalResults, itemsPerPage}'

# Check a specific user by userName (OIN step 4 filter shape):
curl -sS -H "Authorization: Bearer $SCIM_AUTH_TOKEN" \
  "<connector-url>/scim/v2/Users?filter=userName+eq+%22jdoe%22" | jq '.Resources[0] | {id, userName, active}'

# Confirm soft-delete: after Okta deactivates jdoe, native row should still exist with enabled=false:
curl -sS -H "Authorization: Bearer $ACME_CORP_Q3_API_TOKEN" \
  "https://api.acme-corp-q3.example.com/users/jdoe" | jq '{uid, enabled}'
```

All connector logs emit structured JSON with `level`, `ts`, `msg` fields. Grep for `"level":"error"` to triage. Request-ID correlation is in the `x-request-id` response header and logged on every request.