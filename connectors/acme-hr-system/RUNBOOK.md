# RUNBOOK — Acme HR System SCIM Connector

**Ticket:** OKT-10  
**Okta tenant:** `demo-tomato-leopon-10388.oktapreview.com`  
**Terraform workspace:** `staging`  
**Lifecycle policy:** Soft delete — user rows are **never** removed from Acme HR System; deactivation sets `enabled=false` (both PATCH `active=false` and DELETE `/Users/:id` produce this outcome).

---

## 1. Environment variables

| Variable | Purpose | Required in prod? | Default / Format |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector (`Authorization: Bearer …`). Validated on every `/scim/v2/*` request except `/healthz`. | **Yes** | ≥ 32 chars; no whitespace. Generate with `openssl rand -hex 32`. |
| `ACME_HR_API_TOKEN` | Bearer token this connector presents to Acme HR System's native API. | **Yes** | ≥ 32 chars. Obtain from Acme HR System admin console. |
| `ACME_HR_SYSTEM_BASE_URL` | Base URL of the native API. | No | Defaults to `https://api.acme-hr.example.com` (prod). Dev: `https://dev.acme-hr.example.com`. Staging: `https://staging.acme-hr.example.com`. |
| `CONNECTOR_PORT` | TCP port the connector listens on. | No | `3002` |
| `PROMOTION_SIGNING_KEY_CURRENT` | HMAC key for Promotion Manifest signing / verification. | Yes on sign/verify gate | ≥ 32 chars. |
| `PROMOTION_SIGNING_KEY_CURRENT_ID` | Human-readable key ID stamped into the manifest envelope. | No | `current` |

**Dev-mode:** Omit both `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` to run without authentication (useful for local smoke runs). The connector will log warnings but will not refuse to start. **Never deploy to staging or prod without both tokens set.**

---

## 2. Deployment

### Prerequisites

- Node 20+, `npm ci` completed at repo root.
- Acme HR System native API reachable at `ACME_HR_SYSTEM_BASE_URL`.
- Both `SCIM_AUTH_TOKEN` and `ACME_HR_API_TOKEN` set in the environment (prod/staging).

### Local / dev start

```bash
# From repo root
ACME_HR_SYSTEM_BASE_URL=https://dev.acme-hr.example.com \
ACME_HR_API_TOKEN=<dev-token> \
SCIM_AUTH_TOKEN=<local-test-token> \
  npx tsx connectors/acme-hr-system/start.ts
# Logs: {"level":"info","msg":"Acme HR System SCIM connector listening","url":"http://localhost:3002/scim/v2",...}
```

Verify it's alive:

```bash
curl -sS http://localhost:3002/scim/v2/healthz
# Expected: {"status":"ok","uptime_seconds":N,"version":"dev","target_reachable":true}
```

### Staging deploy (Terraform)

```bash
# Ensure env vars are set in your shell or CI/CD secret store.
terraform workspace select staging
terraform apply -auto-approve
```

After apply, confirm the connector reaches the native API:

```bash
curl -sS https://<staging-connector-url>/scim/v2/healthz
# Expected: {"status":"ok","target_reachable":true}
```

### Okta provisioning configuration

In the Okta admin console for tenant `demo-tomato-leopon-10388.oktapreview.com`:

1. Navigate to **Applications → Acme HR System → Provisioning → Integration**.
2. Set **SCIM connector base URL** to `https://<connector-url>/scim/v2`.
3. Set **Authentication mode** to **HTTP Header**.
4. Set **Authorization** to `Bearer <SCIM_AUTH_TOKEN value>`.
5. Click **Test API Credentials** — should return green.
6. Enable **Import Users**, **Assign Users**, **Push Groups** (groups not yet implemented — leave Push Groups off for this release; see Known Limitations).

---

## 3. Rollback

### If staging fails the verify gate

Do **not** promote to prod. Fix the ticket, re-generate, re-run smoke.

### If prod goes wrong after promotion

```bash
# 1. Identify the last-known-good commit from the prior Promotion Manifest.
jq -r .manifest.git_sha last-good-manifest.json

# 2. Check out that commit.
git checkout <last-known-good-sha>

# 3. Re-apply prod.
terraform workspace select prod
terraform apply -auto-approve

# 4. Re-run smoke against prod to confirm.
SCIM_AUTH_TOKEN=<prod-token> \
ACME_HR_SYSTEM_BASE_URL=https://api.acme-hr.example.com \
  npx tsx scripts/smoke/cli.ts \
    --connector-url https://<prod-connector-url> \
    --target-url    https://api.acme-hr.example.com
```

**Blast-radius note:** A production rollback requires the same two-approver gate as a forward promotion (Law 10 AUDIT-TRAIL). Unilateral rollback without approval is a security incident; page the secondary on-call contact immediately.

### Soft-delete safety during rollback

Because all lifecycle operations are soft-deletes (no row removal), a connector rollback carries zero risk of data loss at the Acme HR System level. Rows deactivated during the broken deployment remain with `enabled=false`; they can be reactivated after rollback if required.

---

## 4. Smoke + verification

Three checks must all pass before promoting to staging or prod.

### 4a. Health check

```bash
curl -sS https://<connector-url>/scim/v2/healthz
```

Expected healthy response:

```json
{"status":"ok","uptime_seconds":14,"version":"dev","target_reachable":true}
```

If `target_reachable` is `false`, the connector cannot reach the native API — check `ACME_HR_SYSTEM_BASE_URL` and network routing. HTTP 503 means the health check itself failed.

### 4b. Full smoke cycle

```bash
SCIM_AUTH_TOKEN=<token> \
  npx tsx scripts/smoke/cli.ts \
    --connector-url https://<connector-url> \
    --target-url    https://<native-api-url>
# Expected: exit 0, JSON report with smoke_test_passed=true, log_errors_count=0
```

The smoke script exercises the full lifecycle:
1. `POST /scim/v2/Users` — create a test user.
2. `GET /scim/v2/Users?filter=userName eq "<uid>"` — dedup lookup (OIN step 4).
3. `GET /scim/v2/Users/<id>` — read by ID (OIN step 2).
4. `PATCH /scim/v2/Users/<id>` with `active: false` — deactivate.
5. Verify target reflects `enabled: false` (smoke confirms soft-delete, not hard-delete).
6. `DELETE /scim/v2/Users/<id>` — confirm 204, confirm row still exists in target with `enabled: false`.

### 4c. OIN test suite (pre-submission)

Before submitting to the OIN, run Okta's official SCIM 2.0 SPEC test suite against the staging connector. The 12 required + 1 optional tests are documented in `docs/okta-dialect.md §12`. All 12 required tests must pass.

```bash
# Use Okta's built-in SCIM test runner in the admin console:
# Applications → Acme HR System → Provisioning → Integration → Run Test
```

---

## 5. Known limitations

- **Groups not implemented.** `required_ops` in the ticket does not include `groups_*`. The connector advertises no group support in `/ServiceProviderConfig` (no groups section). Enabling Push Groups in Okta's provisioning config before group support is implemented will result in `404` responses on `/scim/v2/Groups`. Leave Push Groups **off** until a follow-up ticket enables it.

- **Filter is evaluated client-side.** `GET /Users?filter=…` fetches **all** users from Acme HR System and applies the SCIM filter predicate in-memory. For tenants with large user populations (> 5,000 users), this will be slow and may hit memory limits. A follow-up ticket should investigate whether Acme HR System's native API accepts query parameters for server-side filtering.

- **No reactivation attribute re-population.** Per `okta-dialect.md §4` / `§6`: if `deactivation_attribute_clearing` is ever enabled on this connector, reactivating a user via `PATCH active=true` will return an empty profile until Okta re-pushes user attributes. This connector does **not** currently implement attribute clearing on deactivation (no `deactivation_attribute_clearing` field in the ticket), so the risk is low but documented here for future maintainers.

- **Single-node only.** The connector is stateless (all state lives in Acme HR System), so horizontal scaling is safe from a data-consistency standpoint. However, the current Terraform scaffold assumes one node. Multi-node deployment requires a load balancer and is deferred to a future ticket.

- **No SCIM bulk operations.** `ServiceProviderConfig` advertises `bulk.supported: false`. Large imports rely on individual `POST /Users` calls; Okta will paginate accordingly.

- **`meta.created` is approximate.** Acme HR System does not expose a separate creation timestamp. `meta.created` is set to the same value as `meta.lastModified`. This means newly-created users and long-standing users look identical on the `created` field. Purely cosmetic; does not affect provisioning correctness.

---

## 6. On-call / escalation

| Role | Contact | Channel |
|---|---|---|
| Primary (connector owner) | Assigned engineer from OKT-10 | Slack `#okta-provisioning-oncall` + PagerDuty |
| Secondary (Pro Serve backup) | Pro Serve rotation lead | PagerDuty `okta-ps-secondary` |
| Acme HR System API issues | Acme HR System team (`acme-hr-api@example.com`) | Email + Slack `#acme-hr-integrations` |
| Okta tenant admin | Okta admin for `demo-tomato-leopon-10388.oktapreview.com` | Okta admin console + Okta support portal |

### Incident severity + response targets

| Severity | Example | Response target |
|---|---|---|
| **P0** | Okta provisioning completely broken; users cannot log in to apps | 30 minutes |
| **P1** | Partial sync failure; some users not provisioned or deactivated; auth still works | 4 hours |
| **P2** | Non-blocking degradation (slow imports, cosmetic errors, health check flapping) | 1 business day |

### What to check first

1. `/healthz` — is the connector alive AND can it reach the native API?
2. Connector logs — look for `request_id`, HTTP status codes, SCIM error envelopes.
3. Okta admin console → **Reports → System Log** — filter on the connector's app for provisioning errors.
4. Acme HR System admin console — verify the user record exists and `enabled` flag is correct.

### Escalation checklist before paging Acme HR System team

- [ ] Confirmed connector is healthy (`/healthz` returns `target_reachable: true`).
- [ ] Confirmed the failing operation's `request_id` is captured from connector logs.
- [ ] Confirmed the native API returns the expected shape (manually `curl` the affected endpoint with `ACME_HR_API_TOKEN`).
- [ ] Confirmed Okta is sending the expected SCIM payload (Okta System Log → provisioning event → raw payload).