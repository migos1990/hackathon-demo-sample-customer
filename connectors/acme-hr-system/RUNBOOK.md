# RUNBOOK — Acme HR System SCIM Connector

**Ticket:** OKT-10  
**Customer app:** Acme HR System (LDAP-shaped REST API)  
**Okta tenant:** `demo-tomato-leopon-10388.oktapreview.com`  
**Lifecycle policy:** `soft_delete` — users are never hard-deleted; Okta's
deprovisioning signal (PATCH `active:false`) and Okta-initiated DELETE both
flip `enabled=false` on the native row. Row is retained for audit purposes.  
**Terraform workspace:** `staging`

---

## 1. Environment variables

| Variable | Purpose | Required? | Format / Example |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector on every request. Okta's SCIM client reads this from the app's integration settings. | **Yes in staging/prod** | ≥32 random chars, e.g. from `openssl rand -hex 32` |
| `ACME_HR_API_TOKEN` | Bearer token this connector presents to the Acme HR System API. Configured in the Acme HR admin panel under API Keys. | **Yes in staging/prod** | ≥32 chars |
| `ACME_HR_SYSTEM_BASE_URL` | Acme HR System API base URL. Select per environment (see table below). | No — defaults to prod URL | Valid `https://` URL, no trailing slash |
| `CONNECTOR_PORT` | TCP port this connector listens on. | No — defaults to `3002` | Integer, e.g. `3002` |
| `PROMOTION_SIGNING_KEY_CURRENT` | HMAC-SHA256 key for signing/verifying the Promotion Manifest on staging→prod promotion. | Yes at promotion time | ≥32 chars |
| `PROMOTION_SIGNING_KEY_CURRENT_ID` | Human-readable key ID stamped into the manifest envelope. | No — defaults to `current` | Short string, e.g. `2024-q2` |

**Environment URLs:**

| Environment | `ACME_HR_SYSTEM_BASE_URL` |
|---|---|
| dev | `https://dev.acme-hr.example.com` |
| staging | `https://staging.acme-hr.example.com` |
| prod | `https://api.acme-hr.example.com` |

**Dev-mode shortcut:** omit both `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN`
and the connector runs without authentication — suitable for local iteration
only. **Never deploy to staging or prod without both tokens set.**

---

## 2. Deployment

### Prerequisites

- Node.js 20+ (`node --version` → `v20.x.x` or later)
- `npm ci` completed in the repo root
- Acme HR System API reachable at `ACME_HR_SYSTEM_BASE_URL`
- Okta app integration configured to point at this connector's SCIM base URL
  (`https://<host>/scim/v2`) with the matching bearer token

### Local / dev start

```bash
# From repo root
ACME_HR_SYSTEM_BASE_URL=https://dev.acme-hr.example.com \
  npx tsx connectors/acme-hr-system/start.ts
# Expected stdout (JSON):
# {"level":"info","msg":"Acme HR System SCIM connector listening","url":"http://localhost:3002/scim/v2",...}
```

### Staging start (with auth)

```bash
export SCIM_AUTH_TOKEN="$(openssl rand -hex 32)"
export ACME_HR_API_TOKEN="<token from Acme HR admin panel>"
export ACME_HR_SYSTEM_BASE_URL="https://staging.acme-hr.example.com"
export CONNECTOR_PORT=3002

npx tsx connectors/acme-hr-system/start.ts
```

### Terraform (staging workspace — OKT-10)

```bash
cd terraform/
terraform workspace select staging
terraform apply -var="scim_auth_token=$SCIM_AUTH_TOKEN" \
                -var="acme_hr_api_token=$ACME_HR_API_TOKEN" \
                -auto-approve
```

### Quick smoke after deploy

```bash
# 1. Health check — connector alive AND target reachable
curl -sf https://<connector-host>/scim/v2/healthz | jq .
# Expected: {"status":"ok","target_reachable":true,...}

# 2. Authenticated user list
curl -sf -H "Authorization: Bearer $SCIM_AUTH_TOKEN" \
  https://<connector-host>/scim/v2/Users?count=1 | jq .
# Expected: {"schemas":["urn:ietf:params:scim:api:messages:2.0:ListResponse"],"totalResults":N,...}
```

---

## 3. Rollback

### If staging fails verification (pre-prod gate)

Do **not** update `promotion_gate.preprod_verified_at` in the ticket. Fix the
failing test or code issue, open a new PR, re-run the full OIN replay-test
suite, then re-promote.

### If prod degrades after promotion

1. Identify the last-known-good commit from the prior Promotion Manifest:
   ```bash
   jq -r '.manifest.git_sha' last-good-manifest-acme-hr-system.json
   ```

2. Check out that commit:
   ```bash
   git checkout <last-known-good-sha>
   ```

3. Re-deploy via Terraform:
   ```bash
   cd terraform/
   terraform workspace select prod
   terraform apply -var="scim_auth_token=$SCIM_AUTH_TOKEN" \
                   -var="acme_hr_api_token=$ACME_HR_API_TOKEN" \
                   -auto-approve
   ```

4. Re-run smoke:
   ```bash
   npx tsx scripts/smoke/cli.ts \
     --connector-url https://<prod-connector-host> \
     --target-url    https://api.acme-hr.example.com
   ```

5. File a post-mortem within 24 hours per PS engagement SLA.

**Blast-radius note:** prod rollback requires the same two-of-two approval as
a forward promotion (Connector Law 10 — AUDIT-TRAIL). A unilateral rollback
is a security incident. Page the secondary approver.

---

## 4. Smoke + verification

Three tiers of verification, all must pass before marking staging green:

### Tier 1 — Health probe

```bash
curl -sf https://<connector-host>/scim/v2/healthz | jq .
```

Expected (healthy):
```json
{"status":"ok","uptime_seconds":42,"version":"dev","target_reachable":true}
```

Expected (degraded — Acme HR API unreachable):
```json
{"status":"degraded","target_reachable":false,"target_error":"..."}
```
HTTP status is `503` when `target_reachable` is false. The load balancer
health check gates traffic on this endpoint.

### Tier 2 — OIN replay-test suite (all 12 required tests)

```bash
npx vitest run replay-test/replay.test.ts \
  --reporter=verbose \
  --testNamePattern="acme-hr-system"
```

Covers OIN-gating tests per `okta-dialect.md §12 Appendix`:

| OIN step | What it verifies |
|---|---|
| 0 | `GET /Users?count=1&startIndex=1` returns valid ListResponse |
| 4 / 8 | `filter=userName eq "<invalid>"` returns empty ListResponse (NOT 404) |
| 6 / 22 | `GET /Users/<nonexistent>` returns 404 + SCIM error envelope |
| 10 | `POST /Users` returns 201 + full body |
| 12 | Follow-up GET by created ID returns the user |
| 14 | Re-POST same userName returns 409 + `scimType:"uniqueness"` |
| 16 | Case-varied `userName eq` filter returns DIFFERENT result (case-sensitive) |
| 20 | Missing/invalid bearer token returns 401 |

### Tier 3 — Full smoke cycle (provision → deactivate → verify)

```bash
npx tsx scripts/smoke/cli.ts \
  --connector-url https://<connector-host> \
  --target-url    https://staging.acme-hr.example.com \
  --scim-token    "$SCIM_AUTH_TOKEN"
```

Expected: exit 0, JSON report with `smoke_test_passed: true`, `log_errors_count: 0`.

The smoke script:
1. Creates a test user via `POST /scim/v2/Users`
2. Reads the user back via `GET /scim/v2/Users/:id`
3. Deactivates via `PATCH /scim/v2/Users/:id` `{active: false}`
4. Verifies the Acme HR API reflects `enabled: false` (target-verify step)
5. Verifies the user still exists on the target (soft-delete — row is retained)
6. Cleans up by issuing `DELETE /scim/v2/Users/:id` (which also soft-deletes)
7. Verifies final state: user row exists, `enabled: false`

Step 5 and 7 are the soft-delete policy assertions. If either fails, the
lifecycle policy is mis-wired.

---

## 5. Known limitations

- **No server-side filter pushdown.** `GET /Users?filter=...` fetches all
  users from the Acme HR API and filters in-memory inside the connector.
  For tenants with >10,000 users, this will be slow and memory-intensive.
  Mitigation: if the Acme HR API adds a `?filter=` or `?search=` parameter
  in future, push the filter down in `client.ts:listUsers()`. Tracked as a
  future enhancement on OKT-10.

- **Groups not implemented.** `required_ops.groups` is not set in the ticket.
  The connector advertises `User` resources only. `/scim/v2/Groups` returns
  404. If group push is enabled in Okta's app integration settings for this
  connector, Okta will receive 404s on group operations. Do not enable group
  push until groups are implemented (separate ticket required).

- **Single-node only.** The connector is stateless (all state lives in Acme
  HR's API), so horizontal scaling is theoretically safe. However, the current
  Terraform scaffold assumes one instance. Review the scaffold before scaling
  out.

- **No filter pushdown for temporal queries.** `meta.lastModified gt "..."` 
  filters (used by Okta's incremental/delta import) are evaluated in-memory.
  The connector does not pass timestamp predicates to the Acme HR API. For
  large directories, the delta-import cycle will be as slow as a full import.

- **`ping()` uses HEAD /users with GET fallback.** If the Acme HR API rate-
  limits health probes (HEAD + possible GET on every liveness check), consider
  replacing with a dedicated `/ping` or `/status` endpoint on the target.

- **Reactivation with attribute clearing is not configured** (no
  `deactivation_attribute_clearing` list in OKT-10). If this is later
  added, review `okta-dialect.md §4` and `§6` for the reactivation/empty-
  profile edge case before implementing.

---

## 6. On-call / escalation

| Role | Contact | Hours |
|---|---|---|
| **Primary (connector owner)** | Assigned PS engineer — see OKT-10 ticket assignee | Business hours + on-call per PS rotation |
| **Secondary (PS backup)** | PS team lead — see internal Slack `#ps-okta-connectors` | Business hours |
| **Acme HR API team** | `api-support@acme-hr.example.com` — for target-API errors (non-2xx from the native API) | Per Acme HR SLA |
| **Okta support** | `https://support.okta.com` — for Okta-side provisioning issues visible in the Okta admin UI | Per Okta SLA |

### Incident runbook

**P0 — Auth broken (all provisioning failing with 401/403):**
1. Check `SCIM_AUTH_TOKEN` matches the token configured in Okta's app
   integration settings (Okta admin UI → Applications → Acme HR System →
   Provisioning → API Integration → Edit).
2. Check `ACME_HR_API_TOKEN` is valid against the Acme HR admin panel.
3. Rotate the affected token, update Okta's integration settings and the
   connector's env var, redeploy.
4. Verify with Tier 1 health probe.
5. Page secondary if not resolved within 30 minutes.

**P1 — Partial provisioning failures (some users failing, others succeeding):**
1. Pull connector logs filtered by `level=error`.
2. Look for `AcmeHrSystemApiError` with a non-409 status — indicates the
   Acme HR API is rejecting specific payloads.
3. Check the `detail` field in the SCIM error response Okta is logging in
   the admin UI (Applications → Acme HR System → Provisioning → Activity).
4. If the error is `scimType:"uniqueness"` on a user that should not exist,
   check for duplicate `uid` values in the Acme HR directory.
5. Escalate to Acme HR API team if the rejections originate at the native API.

**P2 — Slow provisioning / timeouts:**
1. Check connector `/healthz` — confirm `target_reachable: true`.
2. Review "Known limitations §1" — large directory + in-memory filter.
3. Check Okta's provisioning task queue in the admin UI for queue depth.
4. Escalate to Acme HR API team if target response times are elevated.

**SLA targets (PS engagement, not a contractual commitment):**
- P0: respond within 30 minutes, mitigate within 2 hours.
- P1: respond within 4 hours, mitigate within 1 business day.
- P2: respond within 1 business day.