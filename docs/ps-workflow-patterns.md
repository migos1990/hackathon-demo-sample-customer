# PS Workflow Patterns — SCIM is Flow One of N

**Purpose:** name explicitly that SCIM connector generation is ONE instance of a more general pattern — ticket-driven, gate-enforced PS work. The harness (14 meta-laws, 10 connector laws, pre-commit + CI gates, signed Promotion Manifest, orchestrator pipeline) generalizes to other flows a Pro Serve consultant does. This doc names the flows we've thought through, what changes per flow, and what's constant.

This is NOT a roadmap. It's a scope articulation. Each flow below is labeled with current status so judges + readers can distinguish "shipped" from "pattern identified" from "aspirational."

---

## The invariant: any PS work that fits this shape can use the harness

```
  ticket (template-driven YAML + narrative)
      ↓
  orchestrator picks it up
      ↓
  agent generates an artifact (code / plan / doc / config)
      ↓
  harness gates validate the artifact
      ↓
  CI checks run on the PR
      ↓
  pre-prod verify gate exercises the artifact in a safe env
      ↓
  signed Promotion Manifest pins what passed
      ↓
  human approves promotion
      ↓
  prod deploy / deliverable shipped to customer
```

**What's constant across flows:**

- Ticket template at `ticket-templates/<flow>.md` with a machine-parseable YAML front-matter (validated at `scripts/validators/ticket-validator.ts`)
- Per-flow "laws" the artifact must satisfy (pattern-matched to `docs/connector-laws.md`)
- Signed Promotion Manifest envelope (`scripts/promotion-manifest/`)
- Integration docs per external dependency (Law 14)
- Pre-commit hook + CI workflow running the flow's validators

**What varies per flow:**

- The ticket-template fields (different flow = different customer intake)
- The harness-context files the agent reads (what grounds it)
- The artifact shape the agent emits (code vs. doc vs. config)
- The pre-prod verify gate (different deliverables have different "safe exercise" semantics)
- The customer evidence (signed manifest carries different verify-result fields)

---

## Flow 1 — SCIM Connector Generation · **SHIPPED**

The hackathon demo. Customer has a custom app without an OIN connector; ticket describes the app's native API + Okta target; agent generates a SCIM 2.0 connector bridging them.

**Ticket template:** `ticket-templates/new-scim-connector.md` (schema at `ticket-templates/schema.json`)
**Harness context:** `docs/okta-dialect.md`, `docs/patterns/01-ldap.md`, `skeleton/*`, reference connector `connectors/acme-hr/*`
**Artifact:** 6-8 TypeScript files under `connectors/<customer-slug>/` + RUNBOOK.md
**Pre-prod verify:** `runSmoke` (3-step SCIM provision/deactivate/target-verify cycle), OIN SPEC Tests via `replay-test/`, terraform plan idempotency (Law 5 — wired post-tenant-provisioning)
**Signed-manifest fields:** `vitest_passed`, `oin_spec_tests_passed`, `smoke_test_passed`, `log_errors_count`, `tf_plan_empty`

**Status:** end-to-end live-verified against real LiteLLM 2026-05-05. Agent produced 7 files, 60KB, 292s on synthetic BigCorpHR ticket. Evidence at `examples/generated-connectors/bigcorp-hr/`. Gate results at `examples/generated-connectors/bigcorp-hr/GATE-RESULTS.md`.

---

## Flow 2 — POC Plan Generation · **Pattern identified, not built**

Customer engagement opens; PS needs a concrete POC plan: success criteria, tenant setup, test users, evaluation rubric, milestone gates. Today a senior consultant writes this from memory + prior templates; ~3-4 hours per POC.

**What a ticket would contain:**
- Customer profile (industry, size, existing IdP, key integrations)
- POC scope (which Okta products — Workforce Identity, CIAM, Governance?)
- Success criteria inputs (KPIs the customer wants to prove)
- Timeline constraints
- Stakeholder list

**What the agent would emit:**
- `poc-plans/<customer-slug>/POC-PLAN.md` — sections for scope, success criteria, tenant setup, test user matrix, week-by-week milestones, failure criteria (when to call it off), handoff-to-purchase success triggers
- `poc-plans/<customer-slug>/eval-rubric.md` — measurable criteria per week
- `poc-plans/<customer-slug>/test-users.csv` — synthetic user fixtures for the POC tenant

**Laws that'd apply (mapping from connector-laws):**
- **RUNBOOK-COMPLETE analog** — POC plan must have all N required sections
- **DIALECT-CITED analog** — every product-capability claim must cite `references/products/` (in the `presalesInterns` repo) or Okta docs
- **SECRETS-OUT** — no real customer PII in the POC plan (synthetic only)
- **AUDIT-TRAIL** — signed manifest pins which POC plan shipped to customer + who approved

**Harness reuse:** 100% of the scaffolding (orchestrator, CI gates, signed manifest, Linear polling). What needs building: poc-plan ticket template + schema, POC-specific validators (every section filled, rubric has measurable KPIs not aspirational text), harness-context loader that reads POC reference materials.

---

## Flow 3 — Customer Migration Assessment · **Pattern identified, not built**

Customer has a legacy IdP (ADFS, Ping, Entra ID, Keycloak, home-grown) and asks PS for a migration assessment: what's the complexity, where are the risks, what's the phased cutover plan.

**Ticket inputs:**
- Current IdP + version
- Inventory of downstream apps (protocols: SAML, OIDC, WS-Fed, header-based)
- User base size + AD integration state
- Compliance constraints (SOC2, HIPAA, ITAR)
- Target timeline

**Agent emits:**
- `migration-assessments/<customer-slug>/ASSESSMENT.md` — current state, target state, gap analysis, phased plan with per-phase risks + rollback criteria
- `migration-assessments/<customer-slug>/risk-register.md`
- `migration-assessments/<customer-slug>/app-inventory-rubric.csv`

**Laws:**
- **RUNBOOK-COMPLETE analog** — all sections filled
- **DIALECT-CITED analog** — every claim about legacy-IdP behavior cites the vendor's docs (ADFS docs if source is ADFS, etc.)
- **SECRETS-OUT** — synthetic user / app names only
- **AUDIT-TRAIL** — same signed-manifest pattern

**New concern:** the source of truth for legacy-IdP behavior is vendor-specific. Harness context needs `references/legacy-idps/<vendor>.md` files (these exist in `presalesInterns/references/competitive/` already — just needs a loader).

---

## Flow 4 — OIN Submission Packaging · **Pattern identified, not built**

An ISV or customer wants their app listed in Okta's Integration Network. PS packages the submission: integration guide, screenshots, test evidence, security review artifacts, Okta-side app template config.

**Ticket inputs:**
- ISV contact info
- App auth methods + SCIM capabilities
- Screenshots (attached to ticket)
- Compliance attestation inputs

**Agent emits:**
- `oin-submissions/<slug>/INTEGRATION-GUIDE.md` (customer-facing)
- `oin-submissions/<slug>/test-evidence/` (curated screenshot + video inventory)
- `oin-submissions/<slug>/okta-app-template.json` (Okta-side config)

**Laws:**
- **DIALECT-CITED** fires hard here — every claim about Okta OIN requirements must cite `developer.okta.com/docs/guides/scim-provisioning-integration-prepare/` or equivalent.
- **SMOKE-GREEN analog** — the integration guide must include a "smoke procedure" the OIN reviewer can reproduce.

---

## Flow 5 — Security Posture Report · **Pattern identified, not built**

Customer asks for an identity-security posture assessment: what's the current state against Okta's best-practices matrix, where are the gaps, what's the prioritized remediation plan. Reads `presalesInterns/references/benchmarks/*` + the customer's own data.

**Ticket inputs:**
- Customer tenant URL
- Scope (workforce only? workforce + customer identity?)
- Access level PS has to the tenant (read-only query vs. admin)
- Report deadline + audience (CISO / board / compliance auditor)

**Agent emits:**
- `posture-reports/<customer-slug>/REPORT.md` with exec summary, findings, remediation roadmap
- `posture-reports/<customer-slug>/data/` — raw tenant queries + rollup CSVs (synthetic for the POC)

**Laws:**
- **DATA-LAW** (14 meta-law #13) fires hard — every recommendation must carry the query (or its equivalent) + numerator/denominator inline.
- **SECRETS-OUT** — tenant data is redacted per `scripts/sanitize-payload.ts` equivalents before the report leaves.
- **AUDIT-TRAIL** — signed manifest pins the exact tenant state the report was based on.

---

## What this doc does NOT commit to

- **No timeline** on Flows 2-5. They're candidate patterns, not roadmap items. A post-hackathon planning cycle would pick one to build next based on customer demand + engineering capacity.
- **No claim that every PS deliverable fits this shape.** Workflows that require heavy real-time customer interaction (live discovery calls, stakeholder workshops) don't fit the "ticket → agent → artifact" shape at all. Those stay human-driven.
- **No claim that the harness is "done."** Flow 1's gate list (10 connector laws) was designed from SCIM-specific experience. Other flows will surface new law categories we haven't named yet. The harness EVOLVES per flow.

## What this doc is for

1. **Submission + demo positioning.** When a judge asks "cool, but is this just a SCIM tool?" the answer is "no — SCIM is flow one of a ticket-driven PS automation architecture. Here's the generalization."

2. **Post-hackathon planning signal.** If the Agentic Internal Tools track leaders (who review submissions async) want to fund a next flow, this doc is the shortlist.

3. **Internal clarity on what varies vs what's constant.** When a new PS consultant joins the team building this, they read this doc and know: "the harness, orchestrator, signed manifest, CI workflow — these are invariant. Per-flow I need: a ticket template, a pattern doc, a harness-context loader, a validator set, and a pre-prod verify gate."

---

## Why this framing earns trust

The connector laws (`docs/connector-laws.md`) are currently written as 10 rules specific to SCIM connectors. Generalizing them to a **PS-work artifact charter** — every agent-generated deliverable ships with test evidence, cited sources, a rollback story, an audit trail — is the move from "we automated one thing" to "we encoded the rigor a senior consultant brings."

Customers accept agent-generated deliverables not because the agent is skilled (it isn't, consistently) but because the GATES the deliverable survives are mechanical, auditable, and extensible.

---

## Last updated

2026-05-05 — initial doc alongside the CI workflow commit (`68a662b`). User prompt: "similar to the expanded scope of this project, connector is one flow out of the many things a PS resource would do."
