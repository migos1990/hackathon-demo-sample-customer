# RUNBOOK — AcmeCorpQ3 SCIM Connector

**Ticket:** OKT-57  
**Customer app:** Custom SCIM Connector for Internal HR System  
**Slug:** `acme-corp-q3`  
**Okta tenant:** `demo-tomato-leopon-10388.oktapreview.com`  
**Terraform workspace:** `staging`  
**Lifecycle policy:** `soft_delete` — user rows are NEVER deleted; `enabled: false` is the terminal deactivated state.  
**Source model:** LDAP-shaped (`uid` / `givenName` / `sn` / `mail` / `enabled`)  

---

## 1. Environment variables

| Variable | Purpose | Required in prod? | Format / notes |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector on every SCIM request | **Yes** | ≥ 32 chars, random, rotated per key-rotation policy |
| `ACME_CORP_Q3_API_TOKEN` | Bearer token this connector presents to AcmeCorpQ3 HR API | **Yes** | Provisioned by AcmeCorpQ3 team; from env var `ACME_CORP_Q3_API_TOKEN` per ticket OKT-57 `auth_credential_env_var` |
| `ACME_CORP_Q3_BASE_URL` | Base URL of the AcmeCorpQ3 HR API | No | Defaults to `https://api.acme-corp-q3.example.com`. For staging set to `https://api.dev.acme-corp-q3.example.com` |
| `CONNECTOR_PORT` | TCP port the connector listens on | No | Integer; defaults to `3002` |
| `PROMOTION_SIGNING_KEY_CURRENT` | HMAC key used to sign Promotion Manifests | Yes (on sign/verify gate) | ≥ 32 chars; managed by Pro Serve ops |
| `PROMOTION_SIGNING_KEY_CURRENT_ID` | Human-readable key ID stamped into the signed envelope | No | Defaults to `current`; change on key rotation |

### Dev-mode shortcuts

In local development, omit `SCIM_AUTH_TOKEN` and `ACME_CORP_Q3_API_TOKEN`. The skeleton's bearer-auth middleware becomes a no-op when `SCIM_AUTH_TOKEN` is absent, and the HTTP client sends no `Authorization` header when `ACME_CORP_Q3_API_TOKEN` is absent.

**Never ship a production deploy without both `SCIM_AUTH_TOKEN` and `ACME_CORP_Q3_API_TOKEN` set.** The connector logs a `WARNING` to stdout at startup when either is missing — check the startup log after any deploy.

---

## 2. Deployment

### Prerequisites

- Node.js 20 or later
- `npm ci` completed at repo root
- AcmeCorpQ3 HR API reachable at `ACME_CORP_Q3_BASE_URL`
- `SCIM_AUTH_TOKEN` and `ACME_CORP_Q3_API_TOKEN` set in the runtime environment
- Terraform workspace `staging` (or `prod`) initialized and authenticated

### Start the connector (local / dev)

```bash
# Set required vars (dev values — placeholders only, never real tokens here)
export ACME_CORP_Q3_BASE_URL=https://api.dev.acme-corp-q3.example.com
export ACME_CORP_Q3_API_TOKEN=<token-from-acme-corp-q3-team>
export SCIM_AUTH_TOKEN=<random-32-char-string>
export CONNECTOR_PORT=3002

# Start connector
npx tsx connectors/acme-corp-q3/start.ts
# Expected startup log line (JSON):
# {"level":"info","message":"AcmeCorpQ3 SCIM connector started","port":3002,...}
```

### Deploy to staging via Terraform

```bash
terraform workspace select staging
terraform apply -var="scim_auth_token=$SCIM_AUTH_TOKEN" \
                -var="acme_corp_q3_api_token=$ACME_CORP_Q3_API_TOKEN" \
                -var="acme_corp_q3_base_url=$ACME_CORP_Q3_BASE_URL" \
                -auto-approve
```

After apply completes, confirm the connector is live:

```bash
curl -sS https://<staging-connector-hostname>/scim/v2/healthz
# Expected: {"status":"ok","target_reachable":true,...}
```

Run the smoke test (see §4) before marking staging verified in the Promotion Manifest.

### Deploy to production

Production deployment requires a signed Promotion Manifest with `preprod_verified_at` and two approver signatures per Connector Law 10 (AUDIT-TRAIL). Unilateral promotion is a security incident.

```bash
# After staging passes smoke + approvals:
terraform workspace select prod
terraform apply -var="scim_auth_token=$PROD_SCIM_AUTH_TOKEN" \
                -var="acme_corp_q3_api_token=$PROD_ACME_CORP_Q3_API_TOKEN" \
                -var="acme_corp_q3_base_url=https://api.acme-corp-q3.example.com" \
                -auto-approve
```

---

## 3. Rollback

### Identify last-known-good

Every promoted build produces a signed Promotion Manifest in `manifests/`. The manifest pins the exact git commit SHA and tag.

```bash
# Find the last manifest with promoted_to_prod_at set
ls -t manifests/*.json | head -5
jq -r '.manifest.git_tag' manifests/<last-good>.json
```

### Roll back

```bash
# 1. Check out the last-known-good commit
git checkout <last-known-good-tag>

# 2. Re-apply terraform (prod workspace)
terraform workspace select prod
terraform apply -var="scim_auth_token=$PROD_SCIM_AUTH_TOKEN" \
                -var="acme_corp_q3_api_token=$PROD_ACME_CORP_Q3_API_TOKEN" \
                -var="acme_corp_q3_base_url=https://api.acme-corp-q3.example.com" \
                -auto-approve

# 3. Re-run smoke against prod connector to confirm recovery
tsx scripts/smoke/cli.ts \
  --connector-url https://<prod-connector-hostname> \
  --target-url    https://api.acme-corp-q3.example.com
```

### Rollback approval

Rollback to prod requires the same two-of-two approval as a forward promotion per Connector Law 10. Open a rollback PR, tag two approvers, do NOT `terraform apply` unilaterally.

---

## 4. Smoke + verification

Three checks; all must pass before a staging deploy can be promoted.

### 4a. Liveness check

```bash
curl -sS https://<connector-hostname>/scim/v2/healthz
```

Expected response (healthy):
```json
{"status":"ok","uptime_seconds":42,"version":"dev","target_reachable":true}
```

Expected response (degraded — AcmeCorpQ3 API unreachable):
```json
{"status":"degraded","target_reachable":false,"target_error":"..."}
```
HTTP status 503 when degraded. **Do not promote a degraded connector.**

### 4b. Full smoke cycle

```bash
tsx scripts/smoke/cli.ts \
  --connector-url https://<connector-hostname> \
  --target-url    https://api.dev.acme-corp-q3.example.com
```

The smoke script exercises the following in order, verifying target state after each:
1. `POST /scim/v2/Users` — create smoke user; assert 201 + body
2. `GET  /scim/v2/Users?filter=userName eq "<smoke-user>"` — assert found
3. `GET  /scim/v2/Users/<id>` — assert full profile
4. `PATCH /scim/v2/Users/<id>` with `active:false` — deactivate; assert 200
5. **Target verify** — `GET /users/<uid>` on AcmeCorpQ3 API directly; assert `enabled: false`
6. `DELETE /scim/v2/Users/<id>` — soft-delete; assert 204
7. **Target verify** — confirm row still exists in AcmeCorpQ3 with `enabled: false` (NOT deleted)

Expected output: `exit 0`, JSON report with `smoke_test_passed: true`, `log_errors_count: 0`.

Step 7 is critical for the soft-delete policy: it asserts the row was NOT hard-deleted. If AcmeCorpQ3 returns 404 on the target-verify in step 7, the lifecycle policy is broken — stop, do not promote.

### 4c. OIN test suite equivalence (pre-submission)

Before submitting to OIN, run the replay-test rig:

```bash
npx vitest run replay-test/replay.test.ts --reporter verbose
```

The rig replays the 12 required OIN SPEC tests against the running connector. All 12 must pass. Failure details map directly to the OIN gating steps in `docs/okta-dialect.md §12`.

---

## 5. Known limitations

- **Groups not implemented.** Ticket OKT-57 `required_ops` does not include groups. The connector does not expose `GET /scim/v2/Groups` or handle group-push PATCHes. If the Okta admin enables Group Push on this app, Okta will receive 404s. Enable groups in a follow-up ticket.

- **Filter pushdown is absent.** `GET /scim/v2/Users?filter=...` fetches all AcmeCorpQ3 users in memory and filters them in-process (pattern ldap.md §6 — AcmeCorpQ3 has no server-side SCIM filter API). For tenants with > 10 000 users, this will be slow on every full import. Mitigation: implement server-side filter support in AcmeCorpQ3 and push filter params down in `store.list()`.

- **`meta.created` approximated from `meta.lastModified`.** AcmeCorpQ3's API does not expose a separate `createdAt` field. Both SCIM meta fields are populated from `lastModified`. This is documented behaviour, not a bug — but Okta's import logs may show `created` timestamps that do not match the actual account creation date.

- **Single-node only.** The connector is stateless (no in-process user cache) and delegates all state to AcmeCorpQ3 via the API. Horizontal scaling is safe from a correctness standpoint, but the Terraform scaffold in this ticket provisions a single instance. Multi-node deploy requires load-balancer config outside this connector's scope.

- **No attribute zeroing on deactivation.** Ticket OKT-57 does not configure `deactivation_attribute_clearing`. When a user is deactivated (`enabled: false`), their profile fields (email, name, department) are retained. If GDPR data-minimization is required in the future, add a `deactivation_attribute_clearing` list to the ticket and regenerate — see `docs/okta-dialect.md §6`.

- **Key rotation is manual.** `SCIM_AUTH_TOKEN` and `ACME_CORP_Q3_API_TOKEN` rotation requires a Terraform re-apply with new values. Automated secret rotation (AWS Secrets Manager / HashiCorp Vault) is not wired for this ticket.

- **No metric emission or distributed tracing.** Structured JSON logging and `/healthz` are wired (Connector Law 8 OBSERVABLE). Prometheus/OTel metric emission and distributed tracing are not included — these are deployment-shape decisions deferred to the platform team.

---

## 6. On-call / escalation

| Role | Contact | Availability |
|---|---|---|
| **Primary (connector owner)** | Pro Serve engineer assigned to OKT-57 — check Linear ticket for assignee | Business hours; escalate to secondary for P0 outside hours |
| **Secondary (Pro Serve backup)** | Pro Serve on-call rotation — check PagerDuty schedule `okta-proserve-oncall` | 24 × 7 for P0/P1 after customer goes live in prod |
| **AcmeCorpQ3 API issues** | AcmeCorpQ3 platform team — contact via the customer's internal Slack channel shared with Pro Serve | Per customer SLA |
| **Okta tenant issues** | Okta support ticket against tenant `demo-tomato-leopon-10388.oktapreview.com` | Okta SLA |

### Incident classification

| Severity | Definition | Response target |
|---|---|---|
| **P0** | Okta cannot provision any users (connector returns 5xx on all SCIM calls, or auth is broken) | 30 minutes |
| **P1** | Specific user provision/deprovision failing; others working | 4 hours |
| **P2** | Non-blocking degradation (slow imports, stale filter results, `/healthz` shows degraded but provisioning still works) | 1 business day |

### First-responder checklist

1. Check `/healthz` — is `target_reachable: true`? If false, the AcmeCorpQ3 API is unreachable; escalate to AcmeCorpQ3 team.
2. Check connector startup logs for `WARNING` lines — missing `SCIM_AUTH_TOKEN` or `ACME_CORP_Q3_API_TOKEN` means auth is broken.
3. Check Okta provisioning logs in the admin console at `demo-tomato-leopon-10388.oktapreview.com` — error codes surfaced there map to `scimType` values documented in `docs/okta-dialect.md §8`.
4. Re-run smoke (`§4b`) to reproduce the failure in isolation before touching production.
5. If rollback is needed, follow §3. Do NOT rollback unilaterally — get second approval first.