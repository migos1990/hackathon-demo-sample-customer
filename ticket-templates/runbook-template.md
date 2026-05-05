# RUNBOOK — <CUSTOMER_APP_NAME>

<!--
  EVERY generated connector MUST ship a RUNBOOK.md at the ROOT of its
  connector directory (e.g. `connectors/<customer-slug>/RUNBOOK.md`).
  All six sections below are REQUIRED. scripts/runbook-check.ts validates
  the runbook against this template as a pre-commit + pre-merge gate.

  Closes Connector Laws 7 (REVERSIBLE) and 9 (RUNBOOK-COMPLETE).
  See docs/connector-laws.md for why each section is non-negotiable.

  Fill every section before merging the connector PR. "TBD" is not
  acceptable — the gate will refuse.
-->

## Environment variables

List every env var the connector reads at boot, with: name, purpose, required/optional, format/default.

| Var | Purpose | Required? | Format |
|---|---|---|---|
| `SCIM_AUTH_TOKEN` | Bearer token Okta presents to this connector | Yes | ≥32 chars |
| `<TARGET>_API_TOKEN` | Bearer token this connector presents to the customer's API | Yes | per customer auth config |
| `<TARGET>_BASE_URL` | Customer API endpoint | Yes | https:// URL |
| `CONNECTOR_PORT` | Listen port | No, defaults to 3002 | integer |

## Deployment

Step-by-step. Include the exact commands. Include prerequisites (secret-manager access, tenant admin rights).

Prerequisites:
- Access to the customer's secret store (for `<TARGET>_API_TOKEN`)
- Tenant admin rights on target Okta tenant
- Terraform workspace `staging` (or `prod`) selected

Deploy to staging:
```bash
terraform workspace select staging
terraform apply -auto-approve
# Wait for connector to register /healthz green
curl "$CONNECTOR_URL/healthz"
```

Deploy to prod:
```bash
# Only after a signed Promotion Manifest exists for this commit (Law 10).
cat promotion-manifest-<ticket>.json | \
  PROMOTION_SIGNING_KEY_CURRENT=... \
  npx tsx scripts/promotion-manifest/cli.ts verify
# Exit 0 is required before the following line runs.
terraform workspace select prod
terraform apply -auto-approve
```

## Rollback

The exact command. Include both partial (revert config) and full (redeploy prior tag) paths.

Partial rollback (config-only fix, code stays put):
```bash
terraform workspace select <env>
git checkout <prior-config-ref> -- terraform/
terraform apply
```

Full rollback (revert the entire promoted release):
```bash
git checkout <prior-release-tag>  # from the Promotion Manifest's git_tag field
terraform workspace select <env>
terraform apply
# Re-run smoke
tsx scripts/smoke/cli.ts --connector-url $URL --target-url $TARGET_URL
```

**Blast-radius note:** rollback in prod requires the SAME two-of-two approval as a forward promotion per Law 10. A unilateral rollback is a security incident, not a recovery.

## Smoke + verification

How to verify a deployment is actually working. Exact commands + expected output.

```bash
# 1. Health endpoint
curl -sS $CONNECTOR_URL/healthz
# Expected: {"status":"ok","target_reachable":true}

# 2. Full smoke cycle (provisions 1 synthetic user, deactivates, verifies)
tsx scripts/smoke/cli.ts --connector-url $CONNECTOR_URL --target-url $TARGET_URL
# Expected: exit 0, JSON report with smoke_test_passed=true, log_errors_count=0

# 3. Log error count during first 15 min post-deploy
# (whatever log aggregator the customer uses; AcmeHR uses CloudWatch)
# Expected: zero error-level log lines
```

## Known limitations

Be explicit about what this connector does NOT handle. Customers read this to know when to escalate vs. when to adjust their workflow.

- <limitation 1 — one line>
- <limitation 2 — one line>
- <behavior that would surprise a reader not familiar with this customer's setup>

If this section is empty, that is itself a claim ("we believe we handle everything"). Don't ship with an empty Known Limitations section — name at least the scope boundaries.

## On-call / escalation

Who to page, what the handoff looks like, what time windows.

- **Primary contact (customer IT):** <name + email + Slack>
- **Secondary (Pro Serve):** <name + email + Slack>
- **P0 incident (customer prod down):** <escalation path — PagerDuty / phone>
- **Hours of coverage:** <e.g. Mon-Fri 08:00-18:00 local time; after-hours via PagerDuty>
- **SLA targets:** <response time for P0 / P1 / P2>
