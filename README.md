# SCIM Harness — Pre-Built Baseline for Okta SCIM Connector Generation

Internal Okta Pro Serve artifact. Pre-built skeleton, Okta dialect tribal knowledge, real-payload test corpus, attribute mapping patterns, Terraform module, validators. Agent reads this harness as context when generating per-customer SCIM connectors from Linear tickets.

**Source spec:** `docs/superpowers/specs/2026-05-04-scim-pipeline-hackathon-design.md` (in the `presalesInterns` repo).
**10-day prep plan:** `docs/superpowers/plans/2026-05-04-scim-pipeline-10day-prep.md`.
**Engineering harness:** `AGENTS.md` (14 laws).
**Workflow contract:** `PS_WORKFLOW.md`.

## What's in here

| Path | Purpose |
|------|---------|
| `docs/okta-dialect.md` | Tribal knowledge about how Okta actually sends SCIM requests |
| `docs/attribute-mapping-patterns.md` | Worked source-schema → SCIM mapping patterns (LDAP, Workday, custom-DB) |
| `fixtures/okta-payloads/` | Real captured, sanitized Okta SCIM request/response pairs — the replay corpus |
| `skeleton/` | RFC 7644-compliant SCIM 2.0 server skeleton (TypeScript + Express) |
| `replay-test/` | Runner that replays fixtures against a server instance + asserts semantic equivalence |
| `terraform/okta-scim-module/` | Parameterized Okta Terraform module for SCIM app config |
| `validators/` | SCIM compliance + security + Terraform baseline validators |
| `ticket-templates/` | Linear ticket template + JSON schema the orchestrator validates against |
| `scripts/sanitize-payload.ts` | Strips PII from raw Okta captures into fixture format |

## Dev Quickstart

```bash
nvm use 20           # or: node --version should be >= 20
npm install
npm test              # runs replay-test against skeleton — all fixtures must pass
npm run lint
npm run typecheck
```

## How it's used

1. A consultant fills out a Linear ticket with a customer app's details using the template in `ticket-templates/`.
2. The orchestrator (separate repo: `scim-orchestrator/`) claims the ticket and invokes the Claude Agent SDK with this harness' files as context.
3. The agent generates a per-customer SCIM server (reusing `skeleton/`), attribute mapping (following patterns in `docs/attribute-mapping-patterns.md`), Terraform vars (consuming `terraform/okta-scim-module/`), tests, and a runbook.
4. PR opens on GitHub. Test harness runs. Validators run. Reviewer approves.
5. Terraform applies to the customer's Okta tenant (demo tenants for hackathon). Provisioning kicks off.

## 14 Engineering Laws

See `AGENTS.md`. Every commit, every PR, every agent-generated artifact. Non-negotiable.
