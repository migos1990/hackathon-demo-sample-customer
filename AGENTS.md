# Agent Harness — SCIM Pipeline

This file is the single source of truth for how work happens in this repo. Agents (human and AI) MUST read this before editing. 14 laws gate the work.

## The 14 Laws

### 1. IRON LAW — TDD mandatory
Every code change ships with a test, observed to fail before the implementation lands.

### 2. GOLDEN RULE — worktree + surface-scoped verify
Check for parallel worktrees/agents before editing. Run the verification matched to the surface you touched (not just a generic test command) before claiming done.

### 3. SILVER LAW — read official docs
For any third-party provider (Okta, Linear, Terraform providers, Auth0), read official docs (or query Context7 MCP) before writing integration code. Don't guess field names, auth flows, or API shapes.

### 4. THIRD LAW — design-handoff audit
When a design handoff exists, audit every screen/component against it — typography, color, spacing, hierarchy, copy, motion, a11y — not just the hero.

### 5. OBSERVABILITY LAW — error pipe + health metric + smoke test
Every critical piece (webhook receiver, agent loop, external integration, queue, auth, Terraform apply) ships with all three.

### 6. TRUTH LAW — testable comments
Comments describing behavior must be testable claims. Threat models, auth models, and idempotency claims need a test or an explicit `UNVERIFIED` annotation.

### 7. GATE LAW — reviewer findings become gates
Every reviewer finding becomes a pre-merge gate. Reviewers find new categories; gates catch regressions.

### 8. BLAST-RADIUS LAW — prod has its own env/ref
Production has its own environment/ref. No migration touches prod without flowing dev → staging → prod with verify gates between each. For this repo: the two demo tenants are treated as staging + prod, with Terraform workspaces enforcing the separation.

### 9. POSTMORTEM LAW — silent failures get detectors
Every silent failure lasting >24h becomes an automated detector. A fix is incomplete until the detector is built (or an explicit `UNDETECTABLE` annotation is made).

### 10. PLAN LAW — >3 files OR >50 lines OR critical path requires a plan
Changes at that scope get an explicit plan in conversation BEFORE code lands. Plan amendments are committed, not silent.

### 11. EVAL LAW — LLM prompt/schema change → golden-set run
Every LLM prompt or output-schema change ships with a golden-set eval run. For this repo: the `replay-test/` suite against `fixtures/okta-payloads/` IS the golden set. Regression in replay fixtures blocks merge unless explicitly labeled.

### 12. READ LAW — cite file:line
Before describing what a code path does, READ THE CODE. Cite `file_path:line_number` for the load-bearing claim.

### 13. DATA LAW — SQL + num/denom inline
Recommendations resting on a data argument MUST include the literal query + numerator + denominator + cohort filter inline.

### 14. PROD-READINESS LAW — integration doc per external integration
Every external integration ships with a dedicated integration doc at `docs/integrations/<name>.md` listing env vars, webhooks, secrets, and a post-deploy verification checklist. For this repo: Okta demo tenants, Linear, Terraform provider, Claude Agent SDK via LiteLLM, GitHub each get their own doc.

## Conventions

- **Node 20+**, TypeScript strict mode, `tsc --noEmit` clean on every commit
- **ESLint + Prettier** — enforced via pre-commit hook
- **Vitest** for tests (fast, TS-native; equivalent to pytest for Node)
- **Conventional commits** — `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
- **Every task ends with a commit** — no batching
- **Structured logging** with redaction middleware (no PII in info-level logs per OBSERVABILITY LAW)

## Repo Map

- `docs/okta-dialect.md` — tribal-knowledge doc about Okta SCIM quirks
- `docs/attribute-mapping-patterns.md` — worked source → SCIM mapping patterns
- `docs/integrations/` — per-external-integration docs (PROD-READINESS LAW)
- `fixtures/okta-payloads/` — real captured, sanitized Okta SCIM fixtures (the golden set per EVAL LAW)
- `skeleton/` — RFC-compliant SCIM 2.0 server skeleton
- `replay-test/` — golden-set runner; must be green on every commit
- `terraform/okta-scim-module/` — parameterized Okta-side Terraform module
- `validators/` — SCIM compliance + security + Terraform baseline validators
- `ticket-templates/` — Linear ticket template + JSON schema for orchestrator validation
- `scripts/` — utility scripts (e.g., `sanitize-payload.ts`)

## Running the Laws Locally

```bash
npm install
npm test               # IRON LAW — full suite including replay-test
npm run lint           # ESLint
npm run typecheck      # tsc --noEmit
npm run validate       # runs all three validators against a target server
```

## When a Law Fails

1. The failing law IS the bug; fix it, don't work around it.
2. If a law seems wrong for a specific case, propose an amendment in a PR against this file. Do not silently bypass.
3. `UNVERIFIED` and `UNDETECTABLE` annotations are valid escape hatches — but they must be explicit, in-code, and justified in the commit message.

## Canonical Mirror

These 14 laws also live in the `presalesInterns` repo's `CLAUDE.md`. When they disagree, THIS file wins for work in this repo. Amendments to the laws are PRs updating both files in lockstep.
