# RUNBOOK — Acme HR System SCIM Connector

**Ticket:** OKT-10
**Customer app:** Acme HR System (LDAP-shaped REST API)
**Connector slug:** `acme-hr-system`
**Lifecycle policy:** `soft_delete` — rows are NEVER hard-deleted; deactivation
and DELETE /Users/:id both set `enabled=false` on the target.
**Target Okta tenant:** `demo-tomato-leopon-10388.oktapreview.com`
**Terraform workspace:** `staging`

---

## 1. Environment variables

| Variable | Purpose | Required in prod? | Default | Format |
|---|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents **to this connector** | **Yes** | *(none — dev-mode no-auth if unset)* | ≥ 32 random chars |
| `ACME_HR_API_TOKEN` | Bearer token this connector presents **to the target API** | **Yes** | *(none — dev-mode no-auth if unset)* | ≥ 32 random chars |
| `ACME_HR_BASE_URL` | Acme HR System API base URL | No | `https://api.acme-hr.example.com` | HTTPS URL, no trailing slash |
| `CONNECTOR_PORT` | TCP port the connector listens on | No | `3003` | Integer 1–65535 |
| `PROMOTION_SIGNING_KEY_CURRENT` | HMAC key for Promotion Manifest signing/verification | Yes at promote time | *(none)* | ≥ 32 random chars |
| `PROMOTION_SIGNING_KEY_CURRENT_ID` | Human-readable key ID stamped into the manifest envelope | No | `current` | Short alphanumeric string |

**Environment-to-URL mapping (OKT-10):**

| Environment | `ACME_HR_BASE_URL` value |
|---|---|
| dev | `https://dev.acme-hr.example.com` |
| staging | `https://staging.acme-hr.example.com` |
| prod | `https://api.acme-hr.example.com` |

**Security requirements:**
- Both `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` **must** be set before production deployment.
- If either is absent, the connector logs a `warn`-level message at startup and operates in
  dev-mode (no auth on the relevant boundary). This is intentionally visible and deliberately
  not a hard crash so local development is frictionless.
- Never commit token values to source control. Use your secrets manager
  (AWS Secrets Manager / HashiCorp Vault / GitHub Actions secrets).

---

## 2. Deployment

### Prerequisites

- Node 20+, `npm ci` completed at repo root.
- Acme HR System target API reachable at `ACME_HR_BASE_URL`.
- Terraform CLI installed and authenticated (for staging/prod deploys).

### Local / dev

```bash
# Export env vars (replace with real values or use a .env tool like direnv)
export ACME_HR_BASE_URL=https://dev.acme-hr.example.com
export ACME_HR_API_TOKEN=<dev-token>
export SCIM_AUTH_TOKEN=<dev-scim-token>
export CONNECTOR_PORT=3003

# Start the connector
npm run start:acme-hr-system-connector
# Expected log line:
# {"level":"info","msg":"Acme HR System SCIM connector listening","url":"http://localhost:3003/scim/v2","env":"dev",...}
```

Verify it's alive and can reach the target:

```bash
curl -sS http://localhost:3003/scim/v2/healthz | jq .
# Expected (healthy):
# {"status":"ok","target_reachable":true,"uptime_seconds":N,"version":"dev"}

# Expected (target unreachable):
# HTTP 503, {"status":"degraded","target_reachable":false,"target_error":"..."}
```

### Staging (Terraform)

```bash
terraform workspace select staging
terraform apply -auto-approve
# After apply, confirm connector URL from output and run smoke:
tsx scripts/smoke/cli.ts \
  --connector-url $STAGING_CONNECTOR_URL \
  --target-url    $STAGING_TARGET_URL
```

### Production (Terraform — requires two-of-two approval per Law 10 AUDIT-TRAIL)

```bash
terraform workspace select prod
terraform apply -auto-approve
# Confirm with smoke before closing the promotion gate.
tsx scripts/smoke/cli.ts \
  --connector-url $PROD_CONNECTOR_URL \
  --target-url    $PROD_TARGET_URL
```

Production promotion requires:
1. `preprod_verified_at` timestamped in the ticket's `promotion_gate` block.
2. `preprod_manifest_sha` pinned to the staging manifest.
3. `approver_github_username` filled with a second reviewer — NOT the engineer who deployed staging.

### Okta app wiring

In the Okta Admin UI for tenant `demo-tomato-leopon-10388.oktapreview.com`:

1. Navigate to **Applications → [Acme HR System app] → Provisioning → Integration**.
2. Set **SCIM connector base URL** to the connector's `/scim/v2` base URL.
3. Set **Authentication mode** to `HTTP Header`.
4. Paste the value of `SCIM_AUTH_TOKEN` into the **API token** field.
5. Click **Test API credentials** — should return green.
6. Enable **Import Users**, **Create Users**, **Update User Attributes**, **Deactivate Users**.

---

## 3. Rollback

### If staging smoke fails (never promoted to prod)

Fix the ticket, re-generate the connector, re-run smoke. Do not promote until `smoke_test_passed: true`.

### If prod breaks after promotion

1. Identify the last-known-good git tag from the prior Promotion Manifest:
   ```bash
   jq -r .manifest.git_tag last-good-manifest.json
   ```
2. Check out that ref:
   ```bash
   git checkout <last-known-good-tag>
   ```
3. Re-apply prod (requires the same two-of-two approval as a forward promotion):
   ```bash
   terraform workspace select prod
   terraform apply -auto-approve
   ```
4. Re-run smoke to confirm recovery:
   ```bash
   tsx scripts/smoke/cli.ts --connector-url $PROD_CONNECTOR_URL --target-url $PROD_TARGET_URL
   ```
5. File a post-mortem within 24 hours (template: `docs/post-mortem-template.md`).

**Blast-radius note:** a unilateral rollback without the second approver is a
security incident, not a recovery. Page the on-call lead before bypassing the gate.

---

## 4. Smoke test and verification

Three sequential checks. All three must pass before closing a promotion gate.

### Check 1 — health probe

```bash
curl -sS $CONNECTOR_URL/scim/v2/healthz | jq .
```
Expected:
```json
{ "status": "ok", "target_reachable": true, "uptime_seconds": 42, "version": "dev" }
```
A `target_reachable: false` response means the connector is up but cannot reach
the Acme HR System API. Fix the target before proceeding.

### Check 2 — full smoke cycle

```bash
tsx scripts/smoke/cli.ts \
  --connector-url $CONNECTOR_URL \
  --target-url    $TARGET_URL
```
The smoke script:
1. Creates a user via `POST /scim/v2/Users`.
2. Reads it back via `GET /scim/v2/Users/:id`.
3. Deactivates it via `PATCH /scim/v2/Users/:id` with `{active: false}`.
4. Verifies the target shows `enabled: false` (not a deletion — soft_delete policy).
5. Deletes it via `DELETE /scim/v2/Users/:id` and confirms 204.
6. Verifies the target STILL has the row with `enabled: false` (delete was soft).

Expected: `exit 0`, JSON report with `"smoke_test_passed": true`.

### Check 3 — OIN test suite replay

```bash
tsx scripts/replay-test/cli.ts \
  --connector-url $CONNECTOR_URL \
  --fixture-dir   fixtures/okta-payloads/acme-hr-system
```
All 12 required OIN test cases must pass (steps 0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 22).
Step 16 (Username Case Sensitivity Check) is the most common failure point — the
connector implements case-SENSITIVE `userName eq` matching per okta-dialect.md §2.

---

## 5. Known limitations

- **Groups not implemented.** `required_ops` in OKT-10 does not include group push.
  The `/scim/v2/Groups` endpoint is not wired. If Okta attempts group push, it will
  receive `404`. Do not enable Group Push in the Okta app until a follow-on ticket
  implements group support.

- **In-memory filter only.** `GET /Users?filter=...` fetches ALL users from the Acme
  HR System and filters in-memory. For tenants with large user directories (> 5,000
  users) this will be slow and may time out. A follow-on ticket should add a
  `GET /users?uid=<value>` push-down path if the target supports it.

- **No `createdAt` on the target.** The Acme HR System exposes only `lastModified`.
  `meta.created` in SCIM responses is approximated to `lastModified`. This means
  Okta's **Created** column in the admin UI will show the last-modified time, not the
  true creation time. This is cosmetic — it does not affect provisioning correctness.

- **Reactivation has no attribute re-population flow.** If attribute zeroing is
  enabled in a future ticket, `PATCH active: true` restores `enabled: true` but does
  NOT re-populate zeroed attributes. See okta-dialect.md §4 (reactivation gotcha) and
  §6 (attribute deprovisioning). OKT-10 does not configure attribute zeroing, so this
  is not a current risk — document it here so the next engineer is forewarned.

- **Single-node only.** The connector is stateless (all state lives in the target API),
  so horizontal scaling is architecturally sound. However, the Terraform scaffold
  currently assumes one instance. Add a load balancer + multiple task count before
  scaling out.

- **Manual token rotation.** `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` are static
  secrets with no automated rotation. Rotate at least every 90 days. Add rotation
  automation (Lambda rotation function or Vault dynamic secrets) in a follow-on ticket.

- **No metric emission or distributed tracing.** Structured JSON logging + request-ID
  correlation headers are wired (Law 8 OBSERVABLE). CloudWatch/Loki/Datadog log
  shipping, Prometheus/OTel metrics, and distributed tracing are not yet wired.
  Add in the observability hardening ticket.

---

## 6. On-call and escalation

| Role | Contact | Coverage |
|---|---|---|
| **Primary (connector owner)** | Slack: `#scim-connectors` → tag `@oncall-scim` | Business hours + PagerDuty for P0 |
| **Secondary (Pro Serve backup)** | Assign before customer go-live; update this row | Same rotation as primary |
| **P0 escalation (auth broken in prod)** | PagerDuty `scim-connectors` service; 30-minute SLA | 24 × 7 once customer is live |

**Incident severity classification:**

| Severity | Example | SLA |
|---|---|---|
| P0 | All provisioning broken; users locked out | 30 minutes to first response |
| P1 | Deactivation failing; ex-employees retaining access | 4 hours to first response |
| P2 | Slow imports; cosmetic mapping errors | 1 business day |
| P3 | Logging gaps; documentation errors | Next sprint |

**Before opening a P0 incident,** run the three smoke checks in §4 and paste the output
into the incident ticket. The health probe output (`target_reachable`) immediately
narrows whether the problem is the connector or the target API.

**Okta support escalation:** if a provisioning failure is confirmed to be Okta-side
(e.g. Okta not sending PATCH after user assignment), open an Okta support ticket with:
- Tenant URL: `demo-tomato-leopon-10388.oktapreview.com`
- App integration name in Okta admin UI
- Request-ID from the connector logs (`X-Request-Id` header)
- Timestamp of the failed operation (UTC)