# RUNBOOK — Acme HR System SCIM Connector

**Ticket:** OKT-10  
**Customer app:** Acme HR System  
**Slug:** `acme-hr-system`  
**Okta tenant:** `demo-tomato-leopon-10388.oktapreview.com`  
**Terraform workspace:** `staging`  
**Lifecycle policy:** soft_delete — users are NEVER physically removed; deactivation sets `enabled: false` on the native API.  
**Source model:** LDAP-shaped (uid, givenName/sn, mail, enabled, memberOf DNs).

---

## 1. Environment Variables

| Variable | Purpose | Required in prod? | Default / notes |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector | **Yes** | ≥ 32 chars; rotate on any suspected leak |
| `ACME_HR_API_TOKEN` | Bearer token this connector presents to Acme HR System API | **Yes** | Per OKT-10 `auth_credential_env_var`; sourced from secrets manager |
| `ACME_HR_BASE_URL` | Target API base URL | No | Defaults to `https://api.acme-hr.example.com`; override per environment (see table below) |
| `CONNECTOR_PORT` | HTTP listen port | No | Defaults to `3003` |
| `NODE_ENV` | Runtime environment | No | Set to `production` to enable strict startup validation; any other value is permissive (dev/staging) |

### Per-environment base URL override

| Environment | `ACME_HR_BASE_URL` value |
|---|---|
| dev | `https://dev.acme-hr.example.com` |
| staging | `https://staging.acme-hr.example.com` |
| prod | `https://api.acme-hr.example.com` *(default — no override needed)* |

### Security rules

- **Never commit tokens.** All credentials come from env vars or a secrets manager. Connector Law 4 (SECRETS-OUT).
- In production, the process exits with code 1 at startup if `SCIM_AUTH_TOKEN` or `ACME_HR_API_TOKEN` is unset.
- In dev/staging, missing tokens emit a `WARNING` log line but the process continues. Do not promote to prod without both tokens set.

---

## 2. Deployment

### Prerequisites

- Node 20+, `npm ci` completed at repo root.
- Acme HR System API reachable at `ACME_HR_BASE_URL`.
- `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` available in the execution environment.

### Start (dev / local)

```bash
# Minimal — no auth enforced, targets prod URL (read-only risk).
npx tsx connectors/acme-hr-system/start.ts

# Recommended for local dev — point at dev environment.
ACME_HR_BASE_URL=https://dev.acme-hr.example.com \
  npx tsx connectors/acme-hr-system/start.ts
```

Expected startup log (JSON to stdout):

```json
{
  "level": "info",
  "event": "connector_started",
  "connector": "acme-hr-system",
  "scim_base": "http://localhost:3003/scim/v2",
  "target_base_url": "https://dev.acme-hr.example.com",
  "auth_enabled": false,
  "target_auth_enabled": false,
  "okta_tenant": "demo-tomato-leopon-10388.oktapreview.com",
  "terraform_workspace": "staging"
}
```

### Start (staging)

```bash
export SCIM_AUTH_TOKEN="<staging-scim-token>"
export ACME_HR_API_TOKEN="<staging-acme-token>"
export ACME_HR_BASE_URL="https://staging.acme-hr.example.com"
export NODE_ENV="production"
npx tsx connectors/acme-hr-system/start.ts
```

### Start (production — Terraform)

Once the Terraform scaffold is wired (see §6 Known Limitations):

```bash
terraform workspace select prod
terraform apply -auto-approve
```

Until Terraform is wired, deploy the same way as staging, substituting prod URL and prod credentials.

### Quick sanity check after start

```bash
# 1. Health endpoint (no auth required).
curl -sS http://localhost:3003/scim/v2/healthz
# Expected (healthy): {"status":"ok","target_reachable":true,...}

# 2. ServiceProviderConfig (auth required if SCIM_AUTH_TOKEN is set).
curl -sS http://localhost:3003/scim/v2/ServiceProviderConfig \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN"
# Expected: JSON with patch.supported=true, filter.supported=true.

# 3. Create a test user.
curl -sS -X POST http://localhost:3003/scim/v2/Users \
  -H "Authorization: Bearer $SCIM_AUTH_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{
    "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
    "userName": "smoketest",
    "name": {"givenName": "Smoke", "familyName": "Test"},
    "emails": [{"value": "smoketest@acme-hr.example.com", "primary": true}],
    "active": true
  }'
# Expected: 201 + body with id="smoketest".
```

---

## 3. Rollback

### Staging rollback

Staging is not customer-facing. Roll back by re-deploying the previous git tag:

```bash
# 1. Find the last-known-good commit/tag from the prior Promotion Manifest.
jq -r .manifest.git_tag path/to/last-good-manifest.json

# 2. Check out that ref.
git checkout <last-known-good-tag>

# 3. Restart the connector.
SCIM_AUTH_TOKEN=... ACME_HR_API_TOKEN=... \
  ACME_HR_BASE_URL=https://staging.acme-hr.example.com \
  NODE_ENV=production \
  npx tsx connectors/acme-hr-system/start.ts
```

### Production rollback

Production rollback requires the **same two-of-two approval** as a forward promotion (Connector Law 10 AUDIT-TRAIL). A unilateral rollback is a security incident.

```bash
# 1. Obtain approval from the two required approvers (see §5 On-Call).
# 2. Identify the last-known-good tag from the prior Promotion Manifest.
jq -r .manifest.git_tag path/to/last-good-manifest.json

# 3. Check out and redeploy.
git checkout <last-known-good-tag>
terraform workspace select prod
terraform apply -auto-approve

# 4. Run smoke to confirm restored state.
tsx scripts/smoke/cli.ts \
  --connector-url https://<prod-connector-host>/scim/v2 \
  --target-url    https://api.acme-hr.example.com
# Expected: exit 0, smoke_test_passed=true.
```

### Soft-delete note during rollback

Because the lifecycle policy is **soft_delete**, any users deactivated during a faulty deployment remain as `enabled: false` rows in Acme HR System after rollback. They are NOT automatically reactivated. If affected users need reactivation, a Okta admin must push re-activation (PATCH `active: true`) per user after the rollback.

---

## 4. Smoke + Verification

Three sequential checks. All must pass before promoting to the next environment.

### 4a. Health probe

```bash
curl -sS http://localhost:3003/scim/v2/healthz
```

Expected healthy response:

```json
{
  "status": "ok",
  "uptime_seconds": 12,
  "version": "dev",
  "target_reachable": true
}
```

If `target_reachable: false` or HTTP 503:
- Check `ACME_HR_BASE_URL` is correct for the environment.
- Check `ACME_HR_API_TOKEN` is set and valid.
- Check network connectivity from the connector host to the Acme HR System API.

### 4b. Full smoke cycle

```bash
tsx scripts/smoke/cli.ts \
  --connector-url http://localhost:3003 \
  --target-url    https://staging.acme-hr.example.com
```

Expected: exit 0, JSON report with:

```json
{
  "smoke_test_passed": true,
  "steps_passed": ["create_user", "get_user", "deactivate_user", "verify_deactivated_on_target"],
  "log_errors_count": 0
}
```

The `verify_deactivated_on_target` step confirms that after the SCIM PATCH `active: false`, the native API returns `enabled: false` for the test user — the soft-delete policy is exercised end-to-end.

### 4c. OIN test suite replay

```bash
npm run test:replay -- --connector-url http://localhost:3003 \
  --auth-token $SCIM_AUTH_TOKEN
```

The replay test exercises the 12 OIN-required tests (docs/okta-dialect.md §12 Appendix). All 12 must pass before submitting to Okta's OIN review.

Key OIN tests exercised:
- Step 0: `GET /Users?count=1&startIndex=1` → ListResponse
- Step 4/8: `GET /Users?filter=userName eq "<nonexistent>"` → empty ListResponse (NOT 404)
- Step 10: `POST /Users` → 201 + body
- Step 14: duplicate `POST /Users` → 409 + `scimType: "uniqueness"`
- Step 16: case-sensitive userName filter (`"JDOE"` ≠ `"jdoe"`)
- Step 20: missing auth → 401
- Step 22: unknown user ID → 404

---

## 5. Known Limitations

- **Groups not implemented.** OKT-10 `required_ops` does not include groups. The `/Groups` endpoint returns an empty ListResponse. If Acme HR System needs group push in a future ticket, add `connectors/acme-hr-system/routes/groups.ts` and wire it in `server.ts`.

- **Filter pushdown absent.** `GET /Users?filter=...` fetches all users from Acme HR System and filters in memory. For directories with > 5,000 users this will be slow and may time out. If Acme HR System adds a server-side filter API, implement `client.listUsersWithFilter(filter: string)` and update `store.list()` to push the filter down.

- **No cursor-based pagination.** RFC 7644 only standardizes offset pagination (`startIndex` + `count`). Large full imports may require many pages. If Okta's import times out, lower the `filter.maxResults` in `ServiceProviderConfig` and document the change in this runbook.

- **Unknown PATCH paths are silently ignored.** Per `mapping.ts` `applyPathValue()`: any PATCH path the connector does not recognise is a no-op rather than a hard error. This prevents a single unknown attribute from aborting a multi-op PATCH (RFC 7644 §3.5.2 atomicity). The trade-off is that misconfigured Okta attribute mappings silently fail. Monitor for "attribute not updating" reports via the structured log (`event: "patch_unknown_path"`).

- **Terraform scaffold not yet wired.** `terraform workspace: staging` is specified in OKT-10 but the Terraform module for this connector is not in this repo yet. Until it is, deploy manually per §2. The Promotion Manifest gate (`promotion_gate.preprod_verified_at` is null in the ticket) must be filled before promoting to prod.

- **Token rotation is manual.** `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` rotation requires a connector restart. Until a secrets-manager rotation hook is wired, plan a maintenance window for rotation.

- **Reactivation + attribute state.** If `deactivation_attribute_clearing` is ever enabled for this customer (not in OKT-10 scope), reactivation via `PATCH active: true` will return the user to Okta with an empty profile. See docs/okta-dialect.md §4 "Field-confirmed reactivation gotcha". If attribute clearing is added, the reactivation flow must re-populate attributes before returning 200.

---

## 6. On-Call / Escalation

- **Primary contact (connector owner):** fill with the Okta Pro Serve engineer assigned to OKT-10.
- **Secondary (Pro Serve backup):** fill before first prod cutover.
- **Customer contact (Acme HR System admin):** fill when onboarding call completes.

### Escalation matrix

| Severity | Definition | Response target | Escalation path |
|---|---|---|---|
| P0 | Okta provisioning completely stopped; users cannot log in | 30 minutes | Page primary → secondary → Pro Serve lead |
| P1 | Provisioning degraded (partial failures, deactivation lag) | 4 hours | DM primary → secondary |
| P2 | Non-blocking issue (attribute mismatch, cosmetic) | 1 business day | Slack thread |

### Common triage steps

**Symptom: Okta shows "provisioning error" for a specific user**
1. Identify the user's `userName` from the Okta error UI.
2. Check connector logs for the `request_id` associated with the failed operation.
3. Check the Acme HR System API directly: `GET /users/<userName>` — does the user exist? Is `enabled` correct?
4. If the user exists on the target but Okta shows an error, check the SCIM response body in the logs for a malformed field (often an enterprise extension field with null value leaking as `null` instead of being omitted).

**Symptom: `healthz` returns `target_reachable: false`**
1. Check Acme HR System API status page.
2. Verify `ACME_HR_BASE_URL` and `ACME_HR_API_TOKEN` are set correctly for the environment.
3. Try a direct curl from the connector host: `curl -sS -H "Authorization: Bearer $ACME_HR_API_TOKEN" $ACME_HR_BASE_URL/users`
4. If network unreachable, escalate to the Acme HR System infrastructure team.

**Symptom: DELETE /Users/:id returns 404 but user exists**
- Check that Okta is using the correct `id` (which equals `userName` / `uid` for this connector — LDAP convention). If Okta has cached a different id from a prior run or import, trigger a full re-import from the Okta admin UI to reconcile.

**Symptom: POST /Users returns 409 for a user that shouldn't exist**
- The user may exist with `enabled: false` (soft-deleted). Okta treats 409 as "user already exists, skip create" (docs/okta-dialect.md §8). If the intent is to re-provision a previously deactivated user, reactivate via PATCH `active: true` instead of a new POST.