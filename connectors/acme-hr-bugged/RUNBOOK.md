# RUNBOOK — AcmeHR SCIM Connector (BUGGED DEMO VARIANT)

This is a DELIBERATELY BUGGED connector used ONLY during the gate-refusal demo beat. Shipping this to an actual customer prod tenant would be a compliance incident. The harness's verify gates refuse to promote it.

See `store.ts` for the exact failure mode.

## Environment variables

| Var | Purpose | Required? | Format |
|---|---|---|---|
| `CONNECTOR_BUGGED_PORT` | Listen port | No (defaults to 3003) | integer |
| `ACME_HR_BASE_URL` | AcmeHR target URL | No (defaults to `http://localhost:4001`) | https:// URL |
| `ACME_HR_API_TOKEN` | Target bearer token | No in dev | ≥32 chars |
| `SCIM_AUTH_TOKEN` | SCIM-side bearer token | No in dev | ≥32 chars |

## Deployment

**DO NOT DEPLOY TO PROD.** This runbook exists because Connector Law 9 requires a RUNBOOK.md for every connector dir, including this demo-only variant. The only sanctioned use is local demo.

```bash
# Local only:
npm run start:acme-hr                    # target
npm run start:acme-hr-connector-bugged   # bugged SCIM (port 3003)
```

If you deploy this to Terraform workspace `staging` or `prod`, the pre-prod verify gate will refuse promotion — by design.

## Rollback

If this variant is accidentally running somewhere:

```bash
# 1. Stop the bugged process.
kill $(pgrep -f 'acme-hr-bugged/start')

# 2. Replace with the correct connector.
npm run start:acme-hr-connector

# 3. Verify with the smoke runner — should exit 0 now.
tsx scripts/smoke/cli.ts --connector-url http://localhost:3002 --target-url http://localhost:4001
```

If the variant somehow reached a real pre-prod tenant: refer to the correct connector's RUNBOOK rollback section. This variant MUST NEVER reach prod — the signed Promotion Manifest flow refuses it at buildManifest time (preprod_verify.smoke_test_passed would be false, throwing during manifest construction).

## Smoke + verification

The smoke script is supposed to FAIL against this variant:

```bash
tsx scripts/smoke/cli.ts \
  --connector-url http://localhost:3003 \
  --target-url    http://localhost:4001
# Expected: exit 1, JSON report with smoke_test_passed=false,
# step 3 (target-verify-deactivated) carries the error
# "target reports enabled=true; connector did not apply deactivation"
```

If this script exits 0 against the bugged variant, something is very wrong — either the bug has been unintentionally fixed, or the smoke runner is broken. Both are outcomes worth investigating.

## Known limitations

- **The entire PATCH-active flow is broken** — that's the point. The bug is NOT an accident, it's a captured real-world failure mode.
- **POST, GET, and LIST work normally** — the bug is scoped to `patch()`. A naïve SCIM test that only exercises POST + GET would miss this entirely. That's exactly why OIN SPEC Test step 7 exists.
- **No other failure modes are injected** — the bugged variant is otherwise indistinguishable from the correct connector. In a real junior-consultant mistake, the bug would be subtle (like this one).
- **Not hardened for any production scenario.** Demo prop only.

## On-call / escalation

- **Who uses this runbook:** demo operator during the 2-minute video shoot (docs/demo-script.md beats 6-8) and the live Watch Party walkthrough.
- **Escalation:** If this variant accidentally lives past the demo shoot, delete the repo directory, or remove the `start:acme-hr-connector-bugged` npm script. Do not merge a prod-facing branch that references this directory.
- **Incident definition:** any attempt to promote this variant to a non-staging environment. The promotion pipeline's signed manifest verify step refuses — but operators should still be paged on the attempt.
