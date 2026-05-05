# Agent-generated connector — BigCorpHR

**This is verbatim output from the orchestrator's agent** (real Claude sonnet-4-6 via Okta's LiteLLM proxy), captured 2026-05-05 as demo-day evidence.

Not production code. Not in tsconfig.include. Intentionally excluded from the harness gates (tsc, dialect-citation lint, runbook-check) because the point of this directory is to show **what the agent emits when handed a synthetic ticket**, warts and all. Judges who want to inspect the agent's actual output can `cat` these files.

## Provenance

- **Orchestrator version:** commit `abb3f15` (post-pipeline composer + full agent chain)
- **Model:** `claude-sonnet-4-6` via `https://llm.atko.ai/v1`
- **Max tokens:** 32000 (streaming path — `scripts/llm/anthropic-client.ts:stream()`)
- **Generation time:** 292.4 seconds
- **Generation date:** 2026-05-05

## Input ticket

Synthetic LDAP-pattern ticket describing `BigCorpHR`:

```yaml
customer_app_name: BigCorpHR
customer_slug: bigcorp-hr
auth_method: bearer
auth_credential_env_var: BIGCORP_HR_API_TOKEN
base_url: https://api.bigcorp-hr.example.com
user_model_source: ldap
lifecycle_policy: soft_delete
target_okta_tenant: demo-customer-a-staging.oktapreview.com
terraform_workspace: staging
required_ops:
  users_create: true
  users_read: true
  users_update_patch: true
  users_delete: true
  users_list: true
  users_filter: true
```

## What the agent produced

| File | Lines | Chars | Commit message |
|---|---:|---:|---|
| `mapping.ts` | 350 | 12762 | feat(bigcorp-hr): attribute mapping SCIM↔BigCorpHR LDAP-shaped source |
| `types.ts` | 90 | 3087 | feat(bigcorp-hr): BigCorpHR native LDAP-shaped domain types |
| `client.ts` | 167 | 5723 | feat(bigcorp-hr): HTTP client for BigCorpHR native API |
| `store.ts` | 222 | 9010 | feat(bigcorp-hr): UserStore implementation wiring BigCorpHR client + mapping |
| `routes/users.ts` | 331 | 10959 | feat(bigcorp-hr): extended users router adding DELETE soft-delete support |
| `server.ts` | 94 | 3542 | feat(bigcorp-hr): connector factory composing skeleton with BigCorpHr store |
| `start.ts` | 92 | 3140 | feat(bigcorp-hr): standalone entrypoint for BigCorpHR connector |
| `RUNBOOK.md` | 324 | 12258 | docs(bigcorp-hr): RUNBOOK — all 6 required sections populated (Law 9) |
| **Total** | **1670** | **60481** | 8 files |

The agent emitted 8 files when the prompt asked for 6 — it split native types out of `mapping.ts` into `types.ts` (reasonable architectural decision) AND added a `routes/users.ts` extension for DELETE soft-delete support (specific to the ticket's `lifecycle_policy: soft_delete` constraint).

## Reproducing

```bash
# Requires ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL in .env.
eval "$(grep -E '^ANTHROPIC_' ../../../.env | sed 's/^/export /')"
npx tsx ../../../scripts/orchestrator/agent/live-probe.ts \
  --write-to examples/generated-connectors/bigcorp-hr \
  --strip-prefix connectors/bigcorp-hr/
```

Output will differ run-to-run — the LLM is not deterministic. Shape should be consistent (6-8 files covering mapping / client / store / server / start / RUNBOOK).

## Caveats (honest)

- **Not validated against the harness gates.** Committing these to `connectors/` would invoke the pre-commit hook's dialect-citation + runbook + tsc checks. Some of the agent's output would likely fail the first pass. That failure IS the gate-refusal demo beat — a new ticket files, a first-pass generates, the pre-commit gate refuses, the orchestrator retries.
- **No tests.** The agent emitted implementation but not test files. Adding tests to the agent's prompt template is a follow-on.
- **The `routes/users.ts` extension may be redundant** — the skeleton's existing `usersRouter` already handles PATCH. The agent added a parallel path for DELETE; a human reviewer would consolidate.

These caveats are documented rather than hidden because the point of this submission is the gating + iteration story, not "look, AI writes perfect code." The harness makes imperfect agent output *safe*.
