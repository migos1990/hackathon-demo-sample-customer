# RUNBOOK — Acme HR System SCIM Connector

**ticket:** OKT-10
**customer:** Acme HR System
**slug:** `acme-hr-system`
**target okta tenant:** `demo-tomato-leopon-10388.oktapreview.com`
**terraform workspace:** `staging`
**lifecycle policy:** `soft_delete` — users are NEVER hard-deleted from the target; deactivation sets `enabled: false`.

---

## 1. Environment variables

| Variable | Purpose | Required? | Format / Notes |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector on every request | **Yes in staging/prod** | ≥32 random chars. Omit ONLY for local dev. Per okta-dialect.md §9. |
| `ACME_HR_API_TOKEN` | Bearer token this connector presents to the Acme HR System native API | **Yes in staging/prod** | Per OKT-10 `auth_credential_env_var`. Omit only if target has no auth in dev. |
| `ACME_HR_BASE_URL` | Base URL of the Acme HR System API | No | Defaults to `https://api.acme-hr.example.com`. Use environment-specific values below. |
| `CONNECTOR_PORT` | TCP port the connector listens on | No | Integer. Defaults to `3003`. |
| `PROMOTION_SIGNING_KEY_CURRENT` | HMAC key for Promotion Manifest signing | Yes at sign/verify time | ≥32 chars. Not needed for runtime operation. |
| `PROMOTION_SIGNING_KEY_CURRENT_ID` | Human-readable key ID stamped into the manifest envelope | No | Defaults to `current`. |

### Per-environment base URLs (OKT-10 `environments` field)

| Environment | `ACME_HR_BASE_URL` value |
|---|---|
| dev | `https://dev.acme-hr.example.com` |
| staging | `https://staging.acme-hr.example.com` |
| prod | `https://api.acme-hr.example.com` |

### Secret management note

All credentials are injected via environment variables — no secrets in code or config files. In staging/prod, source values from your secrets manager (AWS Secrets Manager, HashiCorp Vault, or equivalent) and inject via the deployment platform (ECS task definition environment, Kubernetes Secret, etc.). Per Connector Law 4 SECRETS-OUT: no real tokens ever appear in this repo.

---

## 2. Deployment

### Prerequisites

- Node 20+, `npm ci` completed from repo root.
- Acme HR System API reachable at `ACME_HR_BASE_URL`.
- `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` set (staging/prod).

### Start the connector (local / dev)

```bash
# No auth tokens needed in local dev — connector will warn loudly.
ACME_HR_BASE_URL=https://dev.acme-hr.example.com \
  npx tsx connectors/acme-hr-system/start.ts
# Logs: JSON line with port, target_base_url, auth_enabled, ticket: OKT-10
# SCIM base: http://localhost:3003/scim/v2
```

### Start with auth (staging parity)

```bash
ACME_HR_BASE_URL=https://staging.acme-hr.example.com \
ACME_HR_API_TOKEN=<token-from-secrets-manager> \
SCIM_AUTH_TOKEN=<token-from-secrets-manager> \
CONNECTOR_PORT=3003 \
  npx tsx connectors/acme-hr-system/start.ts
```

### Verify the connector is live

```bash
# Health check (no auth required on /healthz per skeleton convention).
curl -sS http://localhost:3003/scim/v2/healthz
# Expected (healthy):
# {"status":"ok","uptime_seconds":N,"version":"dev","target_reachable":true}
# Expected (target unreachable):
# HTTP 503 {"status":"degraded","target_error":"..."}
```

### Wire to Okta (staging)

1. In the Okta Admin Console for `demo-tomato-leopon-10388.oktapreview.com`, go to **Applications → Provisioning → Integration**.
2. Set **SCIM connector base URL** to: `https://<your-staging-host>/scim/v2`
3. Set **Authentication mode** to `HTTP Header` / `Bearer Token`.
4. Paste the value of `SCIM_AUTH_TOKEN` as the token.
5. Click **Test Connector Configuration** — Okta will hit `/ServiceProviderConfig` and run a basic `GET /Users` probe.
6. Enable: Import Users, Push New Users, Push Profile Updates, Push Groups (disabled — groups not in scope for OKT-10).

### Terraform (staging)

```bash
# Workspace is `staging` per OKT-10 terraform_workspace field.
terraform workspace select staging
terraform plan
# Review — confirm only this connector's resources change.
terraform apply -auto-approve
```

---

## 3. Rollback

### Rollback procedure

```bash
# 1. Identify the last-known-good git tag from the prior Promotion Manifest.
jq -r .manifest.git_tag path/to/last-good-manifest.json

# 2. Check out that ref.
git checkout <last-known-good-tag>

# 3. Re-deploy to staging (Terraform).
terraform workspace select staging
terraform apply -auto-approve

# 4. Confirm health.
curl -sS https://<staging-host>/scim/v2/healthz

# 5. Re-run smoke test to confirm the rollback is stable (see §4).
```

### Blast-radius note

Per Connector Law 10 (AUDIT-TRAIL): production rollback requires the same two-of-two approval as a forward promotion. A unilateral rollback is a security incident, not a recovery. Escalate to the on-call contact in §6 immediately.

### Data note (soft_delete policy)

Rolling back the connector code does NOT undo any `enabled: false` writes to the Acme HR System. If users were deactivated before the rollback, they remain deactivated. Re-activating users requires a manual PATCH or re-provisioning them through Okta after the rollback stabilises. This is expected behaviour for `soft_delete` — the target's audit state is the source of truth.

---

## 4. Smoke and verification

Three checks must all pass before promoting to prod:

### 4a. Health probe

```bash
curl -sS https://<host>/scim/v2/healthz
# Expected: {"status":"ok","uptime_seconds":N,"version":"...","target_reachable":true}
# Any other response blocks promotion.
```

### 4b. Full smoke cycle

```bash
tsx scripts/smoke/cli.ts \
  --connector-url https://<host> \
  --target-url    https://staging.acme-hr.example.com
# Expected: exit 0, JSON report with smoke_test_passed=true, log_errors_count=0
# The smoke script:
#   1. POST /Users  → verify 201 + user appears in GET /Users/:id
#   2. GET  /Users?filter=userName eq "<smoke-user>"  → verify match (OIN step 4)
#   3. PATCH /Users/:id {op:replace, value:{active:false}} → verify 200 + active:false
#   4. GET /Users/:id → verify active:false persisted
#   5. GET <target>/users/<id> → verify enabled:false on native target (not just SCIM layer)
#   6. DELETE /Users/:id → verify 204, then GET target → verify still exists but enabled:false
#      (soft_delete — row must NOT be gone)
```

### 4c. OIN spec test replay (if replay-test rig is wired)

```bash
npm run replay-test -- --connector-url https://<host> --auth-token $SCIM_AUTH_TOKEN
# Covers all 12 required OIN SPEC tests per okta-dialect.md Appendix §12.
# Expected: 12/12 pass.
```

---

## 5. Known limitations

- **Groups not implemented.** OKT-10 `required_ops` does not include groups. `GET /Groups`, `POST /Groups`, `PATCH /Groups/:id` are not mounted. If Okta group push is enabled for this app, it will receive `404` responses. Do not enable group push until groups are scoped in a follow-on ticket.

- **In-memory filter (no pushdown).** `GET /Users?filter=...` fetches ALL users from the Acme HR System API and filters in memory inside the connector. For tenants with large user directories (>5,000 users), this will be slow and may cause timeouts. A follow-on ticket should add server-side filter support if the Acme HR System API gains a query endpoint. Mitigation for large directories: increase `CONNECTOR_TIMEOUT_MS` and ensure the target API has appropriate pagination.

- **Single-node only.** The connector is stateless (all state lives in the Acme HR System target); it is safe to run multiple instances behind a load balancer. However, the Terraform scaffold in this ticket provisions a single node. Horizontal scaling is a follow-on infrastructure concern.

- **No metric emission.** `/healthz` and structured JSON logs (with `request_id` correlation) are present (Law 8 OBSERVABLE). Prometheus/OTel metric export and log shipping to a central store (CloudWatch, Loki, Datadog) are deployment-shape decisions not yet wired in this repo.

- **`meta.created` approximated.** The Acme HR System API does not expose a separate `createdAt` timestamp. `meta.created` is set to the same value as `meta.lastModified` (the most recent mutation timestamp). This means `meta.created` will drift forward whenever a user record is updated. Okta does not use `meta.created` for provisioning logic, so this is cosmetic — but if the customer's reporting depends on accurate creation dates, a `createdAt` column should be requested from the Acme HR System team and the mapping updated.

- **PATCH atomicity across a failed empty-patch.** If all ops in a multi-op PATCH are unknown-path no-ops, the connector still calls `patchUser` on the target with an empty patch object `{}`. Some target APIs reject an empty PATCH body with `400`. If this occurs, add a guard in `store.ts` to skip the target call when `nativePatch` is empty and return the current user state from a `getUser` call instead.

- **Bearer token rotation is manual.** `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` are static bearer tokens. There is no automated rotation. Key rotation is a manual operational procedure: update the secret in the secrets manager, restart the connector, and update the token value in the Okta app configuration.

---

## 6. On-call and escalation

| Role | Contact | Availability |
|---|---|---|
| Primary (connector owner, OKT-10) | Assigned PS engineer — check Linear ticket OKT-10 for current assignee | Business hours; expand to on-call before prod go-live |
| Secondary (PS backup) | PS team lead — escalate via team Slack channel | Business hours |
| Okta support (tenant issues) | `demo-tomato-leopon-10388.oktapreview.com` admin — open ticket at support.okta.com | Per Okta SLA |
| Acme HR System API support | Customer-side API team — contact info in customer onboarding doc | Customer-defined SLA |

### Incident severity and response targets

| Severity | Criteria | Response target |
|---|---|---|
| P0 | Okta cannot authenticate to the connector; all provisioning blocked | 30 minutes (requires on-call rotation before prod) |
| P1 | Provisioning succeeds but deactivation is broken (users remain active after offboarding) | 4 hours |
| P2 | Non-critical attribute sync failures; users provisioned but missing optional fields | 1 business day |
| P3 | Cosmetic / reporting issues (`meta.created` drift, etc.) | Next sprint |

### Escalation steps

1. Check `/healthz` — is the connector alive and can it reach the Acme HR System API?
2. Check connector JSON logs for `request_id` correlation — find the failing request and trace the error.
3. Check the Acme HR System API directly (can you `curl` `ACME_HR_BASE_URL/users` with the `ACME_HR_API_TOKEN`?).
4. If target is reachable but connector is misbehaving — roll back per §3 and open a Linear ticket.
5. If the Okta tenant is the source of the problem — open a support ticket with Okta, providing the `request_id` from the connector logs.

### Before prod go-live (promotion gate — OKT-10 `promotion_gate`)

The `promotion_gate` fields in OKT-10 are currently unpopulated (`preprod_verified_at: null`). The following must be completed before `promoted_to_prod_at` can be set:

1. `preprod_verified_at` — timestamp of successful smoke test in staging (§4).
2. `preprod_manifest_sha` — SHA of the signed Promotion Manifest from the staging run.
3. `approver_github_username` — GitHub username of the second approver (two-of-two per Law 10).
4. `promoted_to_prod_at` — set only after both approvals and a clean staging smoke test.

Do not point the Okta prod tenant at the prod connector until all four fields are populated.