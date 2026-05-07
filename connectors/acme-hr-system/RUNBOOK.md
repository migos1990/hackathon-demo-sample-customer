# RUNBOOK — Acme HR System SCIM Connector

**Ticket:** OKT-10  
**Customer slug:** `acme-hr-system`  
**Target Okta tenant:** `demo-tomato-leopon-10388.oktapreview.com`  
**Terraform workspace:** `staging`  
**Source model:** LDAP-shaped (`user_model_source: ldap`)  
**Lifecycle policy:** `soft_delete` — users are never hard-deleted; Okta
deactivation maps to `enabled=false` on the target row.

---

## 1. Environment variables

| Variable | Purpose | Required in prod? | Default / notes |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector on every SCIM request | **Yes** | ≥ 32 random chars; generate with `openssl rand -hex 32` |
| `ACME_HR_API_TOKEN` | Bearer token this connector presents to the Acme HR System target API | **Yes** | Obtain from the Acme HR System admin panel |
| `ACME_HR_BASE_URL` | Base URL of the Acme HR System API | No | Default: `https://api.acme-hr.example.com` |
| `CONNECTOR_PORT` | TCP port the connector listens on | No | Default: `3003` |
| `PROMOTION_SIGNING_KEY_CURRENT` | HMAC key used to sign the Promotion Manifest at gate time | Yes (on sign/verify) | ≥ 32 chars; rotate before prod go-live |
| `PROMOTION_SIGNING_KEY_CURRENT_ID` | Human-readable key identifier stamped into the manifest envelope | No | Default: `current` |

**Dev-mode:** omit `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` — both default
to no-op (the skeleton skips auth; the client omits the Authorization header).
The connector still routes correctly; it is simply unauthenticated.

**Never ship a production deployment without both token vars set.** The
startup script (`start.ts`) emits a `warn`-level log line for each unset
token so the gap is visible in log aggregation immediately on startup.

---

## 2. Deployment

### Prerequisites

- Node 20+, `npm ci` completed in the repo root.
- Acme HR System target API reachable at `ACME_HR_BASE_URL`.
- Both secret vars (`SCIM_AUTH_TOKEN`, `ACME_HR_API_TOKEN`) populated in the
  deployment environment (env vars, Secrets Manager, Vault — customer choice).

### Environment matrix

| Environment | Target URL | SCIM listener URL |
|---|---|---|
| dev | `https://dev.acme-hr.example.com` | `http://localhost:3003/scim/v2` |
| staging | `https://staging.acme-hr.example.com` | Set by Terraform output |
| prod | `https://api.acme-hr.example.com` | Set by Terraform output |

### Start (local / dev)

```bash
# From repo root
ACME_HR_BASE_URL=https://dev.acme-hr.example.com \
ACME_HR_API_TOKEN=<token> \
SCIM_AUTH_TOKEN=<token> \
tsx connectors/acme-hr-system/start.ts
# Expected: JSON log line — "Acme HR System SCIM connector started" on port 3003
```

### Staging / prod (Terraform)

```bash
terraform workspace select staging   # or prod
terraform apply -auto-approve
# Terraform outputs: connector_url, target_url
```

The Terraform workspace is `staging` per the ticket. Promotion to `prod`
requires a passing pre-prod verification gate (see §3 Rollback / §5 Smoke).

### Configure Okta

1. In the Okta admin console for `demo-tomato-leopon-10388.oktapreview.com`,
   open the app integration for Acme HR System.
2. Under **Provisioning → Integration**, set:
   - SCIM connector base URL: `<connector_url>/scim/v2`
   - Unique identifier field: `userName`
   - Authentication: Bearer Token → paste `SCIM_AUTH_TOKEN`
3. Enable provisioning features: **Create Users**, **Update User Attributes**,
   **Deactivate Users** (maps to PATCH `active: false` → `enabled=false` on
   the target, per `lifecycle_policy: soft_delete`).
4. Click **Test API Credentials** — should return green.
5. Run **Import** to verify the connector can read users from the target.

---

## 3. Rollback

### Staging rollback (failed verify gate)

If staging smoke fails, do NOT promote. Fix the ticket, re-generate, and
re-deploy to staging:

```bash
# Roll back to the last-known-good git tag
git checkout <last-known-good-tag>
npm ci
terraform workspace select staging
terraform apply -auto-approve
# Re-run smoke to confirm
tsx scripts/smoke/cli.ts \
  --connector-url $STAGING_CONNECTOR_URL \
  --target-url    $STAGING_TARGET_URL
```

### Production rollback (post-promotion incident)

A production rollback is a security incident — it requires the same
two-of-two approval as the forward promotion (Connector Law 10 AUDIT-TRAIL).
Unilateral rollback is not permitted.

```bash
# 1. Identify last-known-good from the prior Promotion Manifest.
jq -r .manifest.git_tag last-good-manifest.json

# 2. Open a P0 incident in the tracker; loop in the second approver.

# 3. Check out the known-good ref.
git checkout <last-known-good-tag>
npm ci

# 4. Apply to prod.
terraform workspace select prod
terraform apply -auto-approve

# 5. Re-run smoke against prod.
tsx scripts/smoke/cli.ts \
  --connector-url $PROD_CONNECTOR_URL \
  --target-url    $PROD_TARGET_URL

# 6. Sign and archive the rollback Promotion Manifest.
tsx scripts/promote/sign.ts \
  --env prod \
  --git-tag <last-known-good-tag> \
  --rollback true
```

---

## 4. Known limitations

- **Groups not implemented.** `required_ops.groups` is not set in OKT-10.
  The connector handles Users only. Enabling group push requires a follow-up
  ticket; the `/Groups` endpoint will return `501 Not Implemented` until then.

- **Filter pushdown absent.** `GET /Users?filter=...` fetches all users from
  the target and filters in memory. Suitable for deployments up to ~10 k users.
  For larger directories, file a follow-up ticket to push the filter to the
  target API.

- **No server-side pagination on target.** The client calls `GET /users` and
  receives the full list. If the target adds a cursor or offset pagination API
  in the future, the client's `listUsers` method needs updating.

- **Enterprise extension fields (employeeNumber, department, title) are
  read-write but not validated against the target's allowed values.** If the
  target enforces an enum on `department`, invalid values will surface as
  a 4xx from the target, which the connector will propagate as a 500 to Okta.
  Add target-side validation in `mapping.ts:scimToNativeCreate` once the
  enum is known.

- **Single-node only.** The connector is stateless (all state lives in the
  target API). Horizontal scaling is safe at the application level but the
  Terraform scaffold provisions a single node. Add an ALB + ASG in the
  follow-up infrastructure ticket if load warrants it.

- **Key rotation is manual.** `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN`
  rotation requires a re-deploy. Automated key rotation (AWS Secrets Manager
  rotation Lambda) is post-hackathon scope.

- **Reactivation with stale attributes.** If attribute zeroing is ever enabled
  (currently NOT configured in OKT-10), reactivation (PATCH `active: true`)
  returns the user with empty profile fields until Okta re-pushes attributes.
  okta-dialect.md §4 documents the resolution path. Flag this before enabling
  attribute zeroing in any future ticket.

---

## 5. Smoke + verification

Three checks; all must pass before promotion.

### 5a. Health probe

```bash
curl -sS http://localhost:3003/scim/v2/healthz
```

Expected (healthy):
```json
{"status":"ok","uptime_seconds":12,"version":"dev","target_reachable":true}
```

Expected (degraded — target unreachable):
```
HTTP 503
{"status":"degraded","target_reachable":false,"target_error":"..."}
```

### 5b. Full smoke cycle

```bash
tsx scripts/smoke/cli.ts \
  --connector-url http://localhost:3003 \
  --target-url    https://dev.acme-hr.example.com
```

Expected: exit 0, JSON report with `smoke_test_passed: true`, `log_errors_count: 0`.

The smoke script covers the OIN-gating lifecycle in order:
1. `GET /Users?count=1&startIndex=1` — list (OIN step 0)
2. `GET /Users?filter=userName eq "<nonexistent>"` — empty ListResponse (OIN step 4/8)
3. `POST /Users` — create (OIN step 10)
4. `GET /Users/<id>` — read-back (OIN step 12)
5. `POST /Users` (duplicate) — 409 + scimType:uniqueness (OIN step 14)
6. `GET /Users?filter=userName eq "<UPPERCASE>"` — case-sensitive mismatch (OIN step 16)
7. `PATCH /Users/<id>` `{active: false}` — soft deactivation
8. Target verify — confirm `enabled=false` on the target row (soft_delete policy check)
9. `PATCH /Users/<id>` `{active: true}` — reactivation (idempotency)
10. `DELETE /Users/<id>` — soft-delete via connector DELETE handler
11. Target verify — row still exists, `enabled=false`
12. `GET /Users/<nonexistent>` — 404 (OIN step 22)
13. Missing auth request — 401 (OIN step 20)

### 5c. Admin UI visual confirmation

If the Acme HR System target exposes an admin panel:

```
open https://dev.acme-hr.example.com/admin
```

Confirm: smoke user appears with status `Deactivated` after step 8.

---

## 6. On-call / escalation

| Role | Contact | When to page |
|---|---|---|
| **Primary (connector owner)** | Louis Migault — Slack `@louis` | Any P0/P1 during business hours |
| **Secondary (Pro Serve backup)** | Assign before customer go-live | P0 out-of-hours or Louis unavailable |
| **Customer Acme HR API team** | Acme HR System API support — obtain contact at onboarding | Target API 5xx / auth failures that originate in the target |
| **Okta support** | https://support.okta.com | Okta-side provisioning errors that survive connector-side fixes |

**Coverage:**  
- Hackathon / demo weekend: best-effort, Slack DM.  
- Production customer: 24×7 rotation required before go-live. Set up PagerDuty
  rotation and fill the Secondary contact above before the production promotion
  gate is opened.

**SLA targets (production, not yet committed):**  
- P0 (auth broken, zero users provisioning): 30-minute response  
- P1 (partial provisioning failure, degraded): 4-hour response  
- P2 (non-critical, single user): 1 business day  

**Incident runbook for common failure modes:**

| Symptom | Likely cause | First action |
|---|---|---|
| Okta reports "Invalid Credentials" on provisioning | `SCIM_AUTH_TOKEN` rotated without updating Okta | Re-enter token in Okta app provisioning settings; re-test |
| All PATCH deactivations return 500 | Target API rejecting PATCH `/users/:uid` | Check target API logs; verify `ACME_HR_API_TOKEN` is valid |
| Health probe returns `target_reachable: false` | Network / firewall between connector and target | Check VPC routes / security groups; ping target from connector host |
| Smoke step 16 (case sensitivity) fails | In-memory filter override regressed | Check `store.ts` `extractSimpleStringEqAttrAndValue`; re-run unit tests |
| `409 uniqueness` on every create | Stale user from a prior smoke run not cleaned up | Manually set `enabled=false` on the stale row via target admin panel; or wipe dev data |