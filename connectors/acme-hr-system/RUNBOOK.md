# RUNBOOK — Acme HR System SCIM Connector

**Ticket:** OKT-10  
**Okta tenant:** `demo-tomato-leopon-10388.oktapreview.com`  
**Terraform workspace:** `staging`  
**Source pattern:** Pattern 1 (LDAP-shaped source)  
**Lifecycle policy:** `soft_delete` — rows are never removed from Acme HR System.

---

## 1. Environment Variables

| Variable | Purpose | Required in prod? | Default / Format |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector on every SCIM request. | **Yes** | ≥ 32 random chars. Generate with `openssl rand -hex 32`. |
| `ACME_HR_API_TOKEN` | Bearer token this connector presents to Acme HR System's REST API. | **Yes** | ≥ 32 random chars. Rotated by the Acme HR System admin team. |
| `ACME_HR_BASE_URL` | Target API base URL. | No | `https://api.acme-hr.example.com` (prod). See environments below. |
| `CONNECTOR_PORT` | TCP listen port. | No | `3003` |
| `PROMOTION_SIGNING_KEY_CURRENT` | HMAC key used to sign the Promotion Manifest. | Yes (on sign/verify) | ≥ 32 chars. |
| `PROMOTION_SIGNING_KEY_CURRENT_ID` | Human-readable key ID stamped into the Promotion Manifest envelope. | No | `current` |

**Environment → base URL mapping (OKT-10):**

| Environment | `ACME_HR_BASE_URL` |
|---|---|
| dev | `https://dev.acme-hr.example.com` |
| staging | `https://staging.acme-hr.example.com` |
| prod | `https://api.acme-hr.example.com` |

**Dev-mode convenience:** omit `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` to run without authentication — the skeleton middleware and the client both no-op on absent tokens. **Never deploy to staging or prod without both tokens set.** The `start.ts` entrypoint emits an `error`-level structured log if `SCIM_AUTH_TOKEN` is unset while `ACME_HR_BASE_URL` points to the prod URL.

---

## 2. Deployment

### Prerequisites

- Node.js 20 or later.
- `npm ci` completed at repo root.
- Acme HR System target API reachable at `ACME_HR_BASE_URL`.
- `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` set in the deployment environment.

### Start the connector

```bash
# Export environment variables (example — use your secrets manager in prod):
export SCIM_AUTH_TOKEN="$(openssl rand -hex 32)"
export ACME_HR_API_TOKEN="<token-from-acme-hr-admin>"
export ACME_HR_BASE_URL="https://staging.acme-hr.example.com"
export CONNECTOR_PORT=3003

# Start:
tsx connectors/acme-hr-system/start.ts
# OR via npm script (add to package.json):
# npm run start:acme-hr-system
```

Expected startup log (stdout, JSON):
```json
{
  "level": "info",
  "msg": "Acme HR System SCIM connector listening",
  "url": "http://localhost:3003/scim/v2",
  "target": "https://staging.acme-hr.example.com",
  "scim_auth_configured": true,
  "target_auth_configured": true,
  "okta_tenant": "demo-tomato-leopon-10388.oktapreview.com",
  "ticket": "OKT-10"
}
```

### Point Okta at the connector

In the Okta Admin Console for tenant `demo-tomato-leopon-10388.oktapreview.com`:

1. **Applications → Your App → Provisioning → Integration**
2. Set **SCIM connector base URL** to:  
   `https://<public-hostname>/scim/v2`  
   (use an ngrok/Cloudflare tunnel for local dev; use the stable hostname for staging/prod)
3. Set **Authentication mode** → `HTTP Header`
4. Set **Authorization** → paste the value of `SCIM_AUTH_TOKEN`
5. **Test connector configuration** — should return green.
6. Enable **Push Users**, **Import Users** as required.

### Staging-specific (Terraform workspace: `staging`)

```bash
terraform workspace select staging
terraform apply -auto-approve
```

Terraform output includes the connector's public URL; update the Okta SCIM URL accordingly.

---

## 3. Rollback

### Rollback a staging deploy

```bash
# 1. Identify the last-known-good commit from the prior Promotion Manifest:
jq -r .manifest.git_sha connectors/acme-hr-system/manifests/last-good-manifest.json

# 2. Check out that commit:
git checkout <last-known-good-sha>

# 3. Re-apply staging:
terraform workspace select staging
terraform apply -auto-approve

# 4. Re-run smoke to confirm the rollback is healthy:
tsx scripts/smoke/cli.ts \
  --connector-url https://<staging-hostname>/scim \
  --target-url    https://staging.acme-hr.example.com
```

### Rollback a production deploy

Production rollback requires **two-of-two approver sign-off** (same gate as forward promotion — Connector Law 10 AUDIT-TRAIL). A unilateral rollback is a security incident; page the on-call approver.

```bash
# Same steps as staging, workspace = prod:
terraform workspace select prod
terraform apply -auto-approve
```

After rollback, file an incident ticket describing:
- What went wrong
- Which manifest SHA was rolled back to
- Both approvers who authorised the rollback

---

## 4. Smoke + Verification

Three checks must all pass before a deploy is considered healthy.

### 4.1 Health endpoint

```bash
curl -sS https://<connector-hostname>/scim/v2/healthz
```

Expected (healthy — connector running and Acme HR System reachable):
```json
{"status":"ok","uptime_seconds":42,"version":"dev","target_reachable":true}
```

Expected (degraded — connector running but Acme HR System unreachable):
```
HTTP 503
{"status":"degraded","target_reachable":false,"target_error":"..."}
```

If the health endpoint returns 503, check:
1. `ACME_HR_BASE_URL` is correct for the environment.
2. `ACME_HR_API_TOKEN` is valid and not expired.
3. Network path between connector and Acme HR System is open (firewall / VPC peering).

### 4.2 Full smoke cycle

```bash
tsx scripts/smoke/cli.ts \
  --connector-url https://<connector-hostname> \
  --target-url    https://staging.acme-hr.example.com
```

Expected: exit code 0, JSON report with `smoke_test_passed: true`, `log_errors_count: 0`.

The smoke script exercises the full OIN-critical path:
- POST /Users (create)
- GET /Users/:id (read)
- GET /Users?filter=userName eq "..." (filter — OIN step 4/8/16)
- PATCH /Users/:id with `active:false` (deactivation — OIN step 7)
- DELETE /Users/:id (soft-delete — verifies row is retained with `enabled:false`)

### 4.3 OIN replay tests

```bash
npx vitest run replay-test/replay.test.ts
```

All 12 required OIN SPEC tests (okta-dialect.md §12 Appendix) must be green. These mirror the test suite at https://developer.okta.com/standards/SCIM/SCIMFiles/Okta-SCIM-20-SPEC-Test.json — the gate for OIN acceptance.

### 4.4 Verify soft-delete behaviour specifically

Because the lifecycle policy is `soft_delete`, verify that:

1. After DELETE /Users/:id → HTTP 204
2. GET /Users/:id still returns the user with `"active": false`
3. Acme HR System shows the user row with `enabled: false` (NOT deleted)

```bash
# Create a test user:
SCIM_USER_ID=$(curl -sS -X POST https://<connector>/scim/v2/Users \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],
       "userName":"smoke-delete-test",
       "emails":[{"value":"smoke-delete@acme-hr.example.com","primary":true}],
       "active":true}' | jq -r .id)

# Soft-delete it:
curl -sS -X DELETE https://<connector>/scim/v2/Users/$SCIM_USER_ID \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN"
# Expect: HTTP 204

# Confirm the user is still fetchable but inactive:
curl -sS https://<connector>/scim/v2/Users/$SCIM_USER_ID \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN" | jq .active
# Expect: false
```

---

## 5. Known Limitations

### Groups not in scope (OKT-10)

`required_ops.groups` was not set in this ticket. The connector handles Users only. Group-push operations from Okta will receive `404 Not Found` responses (no `/scim/v2/Groups` route is mounted). If group-push is required in a future ticket, raise a new Linear ticket and extend this connector; do NOT enable group push in Okta until the route is implemented.

### In-memory filter (no server-side pushdown)

`GET /Users?filter=...` fetches **all** users from Acme HR System and filters in memory. For deployments with a large user base (> 10,000 users), this will be slow and memory-intensive. If Acme HR System exposes a native filter or search API, raise a ticket to implement filter pushdown in `client.ts` + `store.ts`.

### Reactivation + attribute clearing

This connector does **not** implement attribute clearing on deactivation (the `deactivation_attribute_clearing` list was not set in OKT-10). If a future ticket requires GDPR-style attribute zeroing on `active:false`, the reactivation flow described in okta-dialect.md §4 and §6 must be implemented at the same time to avoid the "empty user profile on reactivation" failure mode.

### No multi-instance / horizontal scaling

The connector is stateless by design (all state lives in Acme HR System). It can be horizontally scaled behind a load balancer without session affinity. However, the Terraform scaffold in `staging` workspace currently assumes a single instance. Update the ECS/GCP-CR task count or equivalent before scaling out.

### Bearer token rotation is manual

`SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` rotation requires a redeployment. No automatic secret rotation is wired. For production, integrate with AWS Secrets Manager or Vault and re-deploy on rotation events.

### `meta.created` is approximated

Acme HR System does not expose a separate user creation timestamp. `meta.created` in SCIM responses is approximated from `lastModified`. If accurate creation timestamps are added to the Acme HR System API in the future, update `acmeHrSystemToScim()` in `mapping.ts` to map them directly.

---

## 6. On-Call / Escalation

| Role | Contact | Coverage |
|---|---|---|
| **Primary (connector owner)** | Assign to the Pro Serve engineer who generated this connector — see git blame on `connectors/acme-hr-system/` | Business hours (Mon–Fri, 09:00–18:00 customer timezone) |
| **Secondary (Pro Serve backup)** | Pro Serve on-call rotation — assign before customer go-live | Business hours |
| **P0 escalation (Okta integration broken in prod)** | PagerDuty Pro Serve rotation. Page if: provisioning completely stopped, auth failures in prod, data loss suspected. | 24×7 once customer is in prod; hackathon-grade (best-effort) until then |
| **Customer Acme HR System admin** | To be filled by Okta account team before go-live — needed for `ACME_HR_API_TOKEN` rotation and native API incidents | Per customer SLA |

### SLA targets (production — post-go-live)

| Priority | Definition | Target response | Target resolution |
|---|---|---|---|
| P0 | Provisioning completely stopped or security incident (token leak, data exposure) | 30 minutes | 4 hours |
| P1 | Partial provisioning failure (some users not syncing), deactivation lag > 15 min | 2 hours | 1 business day |
| P2 | Non-critical mapping issue, cosmetic attribute mismatch | 1 business day | 1 week |

**Note:** SLA targets above are goals, not contractual commitments, until formalised in the customer's SOW. The connector is in hackathon state until the `promotion_gate` in OKT-10 is fully populated (both `preprod_verified_at` and `approver_github_username` must be non-null before a prod promotion is permitted).

### Incident response checklist (P0)

1. Check `/scim/v2/healthz` — is the connector alive? Is `target_reachable: true`?
2. Check structured logs (CloudWatch / Loki / Datadog) filtered by `request_id` from the failing Okta webhook event. Look for 4xx/5xx responses.
3. Verify `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` have not expired.
4. If a bad deploy is suspected, roll back per §3 Rollback above.
5. Page the Acme HR System admin if the connector is healthy but the target API is returning errors.
6. File an incident ticket with the `request_id`, error response body, and timeline before handing off.