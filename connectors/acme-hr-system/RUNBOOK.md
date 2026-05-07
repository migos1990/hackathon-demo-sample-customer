# RUNBOOK — Acme HR System SCIM Connector

**Ticket:** OKT-10  
**Customer app:** Acme HR System  
**Okta tenant:** `demo-tomato-leopon-10388.oktapreview.com`  
**Lifecycle policy:** `soft_delete` — user rows are **never removed** from the target; deactivation sets `enabled: false`.  
**Terraform workspace:** `staging`  
**Source model:** LDAP-shaped (Pattern 1 — `docs/patterns/ldap.md`)

---

## 1. Environment variables

| Variable | Purpose | Required in prod? | Default / format |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector on every SCIM request | **Yes** | ≥ 32 random chars. Rotate on any suspected compromise. |
| `ACME_HR_API_TOKEN` | Bearer token this connector presents to the Acme HR System native API (`auth_credential_env_var` in OKT-10) | **Yes** | ≥ 32 random chars. Issued by the Acme HR System admin team. |
| `ACME_HR_BASE_URL` | Base URL of the Acme HR System API | No (defaults to prod) | `https://api.acme-hr.example.com` (prod) · `https://staging.acme-hr.example.com` (staging) · `https://dev.acme-hr.example.com` (dev) |
| `CONNECTOR_PORT` | TCP port the connector listens on | No | `3002` |
| `NODE_ENV` | Runtime environment label (`production` / `staging` / `development`) | Recommended | `development` suppresses auth-token warnings |
| `PROMOTION_SIGNING_KEY_CURRENT` | HMAC key used to sign/verify Promotion Manifests | Yes (on sign/verify) | ≥ 32 chars; never commit to VCS |
| `PROMOTION_SIGNING_KEY_CURRENT_ID` | Human-readable key-ID stamped into the manifest envelope | No | `current` |

**Security notes:**

- Never commit any of the above to source control. Use your secrets manager (Vault / AWS SSM / GitHub Actions secrets).
- `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` must be different values.
- Rotating `SCIM_AUTH_TOKEN` requires updating the Okta provisioning app configuration simultaneously (zero-downtime rotation: add the new token to Okta first, then restart the connector with the new value).

---

## 2. Deployment

### Prerequisites

- Node.js 20 LTS or later (`node --version`)
- `npm ci` completed in repo root
- Acme HR System API reachable from the connector host at `ACME_HR_BASE_URL`
- Terraform ≥ 1.6 (for infra provisioning — Day 6 scope; see note below)

### Start (local / VM)

```bash
# Set environment
export SCIM_AUTH_TOKEN="<your-scim-token>"
export ACME_HR_API_TOKEN="<your-acme-hr-token>"
export ACME_HR_BASE_URL="https://staging.acme-hr.example.com"
export CONNECTOR_PORT=3002
export NODE_ENV=staging

# Start the connector
npm run start:acme-hr-system
# Expected stdout (JSON):
# {"level":"info","msg":"Acme HR System SCIM connector started",
#  "connector":"acme-hr-system","scim_base":"http://0.0.0.0:3002/scim/v2",
#  "environment":"staging","auth_configured":true}
```

### Verify the connector is wired correctly

```bash
# Health check (no auth required)
curl -sS http://localhost:3002/scim/v2/healthz
# Expected: {"status":"ok","uptime_seconds":N,"version":"dev","target_reachable":true}

# ServiceProviderConfig (confirm patch.supported=true for Okta)
curl -sS http://localhost:3002/scim/v2/ServiceProviderConfig | jq .patch
# Expected: {"supported":true}

# Authenticated user list
curl -sS -H "Authorization: Bearer $SCIM_AUTH_TOKEN" \
  "http://localhost:3002/scim/v2/Users?count=1&startIndex=1"
# Expected: 200 + ListResponse with totalResults
```

### Okta provisioning app configuration

In the Okta admin console for tenant `demo-tomato-leopon-10388.oktapreview.com`:

1. Open the provisioning app → **Provisioning** tab → **Integration**.
2. Set **SCIM connector base URL** to the connector's public URL (e.g. `https://scim.acme-hr.example.com/scim/v2`).
3. Set **Unique identifier field for users** to `userName`.
4. Set **Authentication mode** to **HTTP Header**.
5. Paste the value of `SCIM_AUTH_TOKEN` into the **Authorization** field.
6. Click **Test API Connection** — must return green.
7. Enable **Import Users**, **Push Users**, **Push Profile Updates**, **Deactivate Users**.
8. Save.

### Terraform (staging)

> Terraform scaffold for this connector is **Day 6 scope** and not yet wired. When it lands, deploy with:

```bash
cd infra/
terraform workspace select staging
terraform apply -var="scim_auth_token=$SCIM_AUTH_TOKEN" \
                -var="acme_hr_api_token=$ACME_HR_API_TOKEN" \
                -auto-approve
```

---

## 3. Rollback

### Identify the last-known-good version

Every successful promotion writes a Promotion Manifest at
`manifests/acme-hr-system-<timestamp>.json`. Its `manifest.git_tag` field
is the canonical rollback target.

```bash
# Find the most recent successful manifest
ls -t manifests/acme-hr-system-*.json | head -1

# Extract the git tag
jq -r .manifest.git_tag manifests/acme-hr-system-<timestamp>.json
```

### Roll back

```bash
# 1. Check out last-known-good ref
git checkout <last-known-good-tag>

# 2. Re-install (in case deps changed)
npm ci

# 3. Restart the connector (same env vars as current prod)
npm run start:acme-hr-system

# 4. Verify health + smoke
curl -sS http://localhost:3002/scim/v2/healthz
tsx scripts/smoke/cli.ts \
  --connector-url http://localhost:3002 \
  --target-url "$ACME_HR_BASE_URL"
```

### Blast-radius note

A production rollback requires the same two-of-two approval as a forward
promotion (Connector Law 10 — AUDIT-TRAIL). A unilateral rollback is
treated as a security incident. Both approvers must sign the rollback
Promotion Manifest before traffic is redirected.

### Okta-side rollback

If the SCIM contract changed (e.g. schema extension fields added/removed),
Okta may need its provisioning app reconfigured to match the rolled-back
connector. Steps:

1. Open the Okta provisioning app → disable **Push Users** temporarily.
2. Roll back the connector binary (steps above).
3. Re-run **Test API Connection**.
4. Re-enable **Push Users**.

---

## 4. Smoke test and verification

Three checks, all must pass before declaring a deployment healthy:

```bash
# ── Check 1: Health probe ────────────────────────────────────────────────────
curl -sS http://localhost:3002/scim/v2/healthz
# Expected healthy:   {"status":"ok","uptime_seconds":N,"target_reachable":true}
# Expected degraded:  HTTP 503 — target unreachable. Fix ACME_HR_BASE_URL or
#                     ACME_HR_API_TOKEN before proceeding.

# ── Check 2: OIN-gate replay (covers all 12 required OIN tests) ──────────────
npm run test:replay -- --connector-url http://localhost:3002 \
                       --auth-token "$SCIM_AUTH_TOKEN"
# Expected: 12/12 required tests pass, 0 failures.
# Failures here block promotion. Fix the connector; do NOT promote a red build.

# ── Check 3: Full smoke cycle (provision → deactivate → verify target) ───────
tsx scripts/smoke/cli.ts \
  --connector-url http://localhost:3002 \
  --target-url    "$ACME_HR_BASE_URL"
# Expected: exit 0, smoke_test_passed=true, log_errors_count=0.
# The smoke script:
#   a. POSTs a synthetic user to the connector (SCIM create).
#   b. Reads the user back (SCIM GET by id).
#   c. PATCHes active:false (SCIM deactivation).
#   d. Reads the user again — asserts active=false AND enabled=false on target.
#   e. Issues DELETE via SCIM — asserts target still has the row (soft_delete).
#   f. Cleans up (hard-delete on target directly, bypassing SCIM).
# Step (e) is the "target-verify-deactivated" gate (Connector Law 6 SMOKE-GREEN).
```

### Soft-delete verification (OKT-10 specific)

Because `lifecycle_policy: soft_delete`, step (e) above is the most
important. If the target row is gone after a SCIM DELETE, the connector is
incorrectly hard-deleting. Fix in `connectors/acme-hr-system/store.ts`
`delete()` method — it must call `client.patchUser(id, {enabled:false})`
not `client.deleteUser(id)`. See `okta-dialect.md §3`.

---

## 5. Known limitations

- **No server-side filter pushdown.** `GET /Users?filter=...` fetches all users from Acme HR System and filters in memory. For organisations with more than ~10 000 users this will be slow and may cause timeouts. Mitigation: push filter expressions to the target API once its query endpoint supports SCIM-style predicates, and remove the in-memory filter path in `store.ts`.

- **Groups not implemented.** `required_ops` in OKT-10 does not include groups. The `/scim/v2/Groups` endpoint is not wired. If group push is enabled in the Okta app, Okta will receive 404s. To add groups: implement `GET/POST /Groups`, `GET/PATCH /Groups/:id`, and extend `AcmeHrSystemUserStore` with a `GroupStore`. Update `ServiceProviderConfig` to reflect the new capability only after it is implemented.

- **Deactivation attribute clearing is not configured.** OKT-10 does not specify `deactivation_attribute_clearing`. If the customer later requires GDPR attribute zeroing on deactivation (e.g. clearing `mail`, `givenName` on `active:false`), a new ticket must be raised to extend `scimPatchToAcmeHrSystemPatch` and add the zeroing logic atomically with the `enabled:false` flip. See `okta-dialect.md §6`.

- **No multi-instance coordination.** The connector is stateless (all user state lives in the Acme HR System target), so horizontal scaling is possible in theory. However, in-flight PATCH atomicity is only guaranteed within a single process. Running multiple connector instances behind a load balancer may cause race conditions on concurrent PATCHes to the same user. The target API's own locking semantics govern here.

- **Bearer token rotation requires downtime.** Rotating `SCIM_AUTH_TOKEN` requires restarting the connector. Zero-downtime rotation (dual-token grace period) is not yet implemented.

- **Terraform infra module not yet wired.** Day 6 scope. Until it lands, deployment is manual (see §2 Deployment). The `terraform_workspace: staging` in OKT-10 records the intended workspace; infra automation is a pre-production gate.

- **No metric emission.** Structured JSON logs and `/healthz` are wired (Connector Law 8 OBSERVABLE). Prometheus/OpenTelemetry metric export and log shipping to a central store are not yet implemented. Add these before the first production on-call rotation.

---

## 6. On-call and escalation

| Role | Contact | Hours |
|---|---|---|
| Primary connector owner | Louis Migault — Slack `@louis` / PagerDuty alias `scim-connectors` | Business hours + P0 on-call rotation (once rotation is set up) |
| Acme HR System API owner | Acme HR platform team — ticket via `#acme-hr-platform` Slack channel | Business hours; P0 escalation path TBD with customer |
| Okta tenant admin | `demo-tomato-leopon-10388.oktapreview.com` admin console — file an Okta support ticket for tenant-level issues | Okta SLA (varies by contract) |
| Pro Serve backup | TBD — assign before first customer production cutover | |

### Incident severity and response targets

| Severity | Criteria | Response target |
|---|---|---|
| P0 | Okta cannot provision any users; all SCIM requests return 5xx; target API unreachable | 30 minutes (once on-call rotation is live; best-effort during hackathon) |
| P1 | Deactivation failing (users not being disabled in Acme HR System) | 4 hours |
| P2 | Individual user provisioning errors; filter returning wrong results | Next business day |
| P3 | Performance degradation (slow list, high latency); documentation gaps | Scheduled sprint |

### Common failure patterns and first-response steps

**Connector 503 from `/healthz`**  
→ `target_reachable: false` in the health response. Check `ACME_HR_BASE_URL` is correct for the environment. Verify `ACME_HR_API_TOKEN` is valid (`curl -H "Authorization: Bearer $ACME_HR_API_TOKEN" $ACME_HR_BASE_URL/users?count=1`). Check Acme HR System API status page.

**Okta provisioning shows "Error" for a specific user**  
→ Pull the `X-Request-ID` from the Okta provisioning log. Search connector logs for that ID (`grep <request-id> connector.log`). The structured log line for the error will contain `scimType` and `detail` — match against `okta-dialect.md §8` to diagnose.

**User deactivated in Okta but still `enabled: true` in Acme HR System**  
→ Confirm Okta sent `PATCH active:false` (check provisioning log). If it did, check the connector log for the corresponding PATCH request and whether `store.patch()` translated `active:false` → `{enabled:false}`. If the translation is missing, the `scimPatchToAcmeHrSystemPatch` switch in `mapping.ts` has a gap — file a bug and deploy a fix.

**Duplicate user error on Okta-initiated create**  
→ The connector returned 409 + `scimType: "uniqueness"`. This is correct behaviour (Okta dedup signal — `okta-dialect.md §8`). Okta will link to the existing user rather than creating a duplicate. No action required unless the target has an orphaned record that needs cleanup.

**OIN test step 16 failing (case sensitivity)**  
→ The `extractSimpleStringEq` override in `store.ts` may have been removed or bypassed. Re-check that `scim2-parse-filter`'s default predicate is being overridden for `userName eq` expressions. See `okta-dialect.md §2`.