# Connector Laws — Trust Properties Every Generated Connector Must Satisfy

**Why this doc exists:** Trust in agent-generated output does NOT come from trusting the agent. It comes from laws that the HARNESS MECHANICALLY ENFORCES — laws the agent cannot bypass because the gates refuse non-conforming work.

The 14 laws in `AGENTS.md` govern how we BUILD the harness. These 10 **Connector Laws** govern what every generated connector OUTPUT must satisfy. Each law is paired with (a) the harness mechanism that enforces it and (b) the concrete evidence a customer sees.

**Context:** This harness serves the case where a customer has a custom in-house or niche third-party app without an out-of-the-box Okta OIN connector, and needs SCIM provisioning onboarded quickly. Historically this took weeks of senior-consultant rigor because so much can go wrong — PATCH semantics, OIN dialect quirks, lifecycle-policy branching, credential hygiene. These 10 laws ARE that rigor, encoded once in the harness so every generated connector inherits it.

---

## The 10 Connector Laws

### 1. TEST-GREEN — every generated connector ships green tests

**Asserts:** The connector comes with a unit + integration + replay-test suite covering its code paths AND the wire behavior against the target app. All tests pass before PR merges, all tests pass again post-deploy in pre-prod.

**Enforced by:**
- `.githooks/pre-commit` runs `vitest` on every commit — no commit lands red.
- `replay-test/` suite runs against the generated connector in CI — regression in any fixture blocks merge.
- Pre-prod verify gate (`docs/promotion-flow.md` §3) re-runs vitest against the deployed pre-prod instance; the Promotion Manifest's `preprod_verify.vitest_passed` field is literally `"N/N"` and any mismatch at build-time throws (`scripts/promotion-manifest/build.ts:assertVerifyPassed`).

**Evidence customer sees:** `vitest_passed: "N/N"` in the signed Promotion Manifest. PR CI badge.

### 2. OIN-12/12 — passes Okta's OIN SPEC Test suite

**Asserts:** The connector passes all 12 of Okta's `Okta-SCIM-20-SPEC-Test.json` required tests against a real Okta tenant. This is the non-negotiable OIN-acceptance gate for connectors that enter Okta's Integration Network. Connectors that stay private still pass it — the OIN suite is the closest thing to a vendor-neutral correctness baseline for SCIM 2.0.

**Enforced by:**
- `replay-test/` suite covers 12/12 OIN SPEC-equivalent flows offline.
- Pre-prod verify gate runs the OIN SPEC runner against the staging tenant; the Promotion Manifest's `preprod_verify.oin_spec_tests_passed` field is `"N/N"`. `build.ts` refuses manifest creation if not 12/12.

**Evidence customer sees:** `oin_spec_tests_passed: "12/12"` in the signed Promotion Manifest. OIN report attached to PR.

### 3. DIALECT-CITED — every Okta-specific behavior cites its source

**Asserts:** Code paths that handle Okta-specific behavior (PATCH `active:false` vs DELETE, case-sensitive `userName`, lifecycle semantics, Okta-shaped opaque IDs, content-type asymmetry) include a comment citing the relevant `docs/okta-dialect.md` section, RFC clause, or Okta official-doc URL. No magic numbers, no undocumented quirks.

**Enforced by:**
- SILVER LAW review gate on generated PRs: reviewer checks that every Okta-specific decision has a citation.
- TRUTH LAW pre-commit hook flags behavioral comments that aren't testable — forces citations to real docs rather than claims.
- Pre-merge checklist in `.github/pull_request_template.md`.

**Evidence customer sees:** PR description's "Dialect citations" section lists every `docs/okta-dialect.md` section the generated code relies on. Inline code comments point to RFC line numbers and Okta URLs.

### 4. SECRETS-OUT — zero credentials, zero customer data in the repo

**Asserts:** No customer API tokens, no real user PII, no prod tenant URLs with customer identity in them, ever enter a generated repo. All secrets via env vars. All user data synthetic via `scripts/sanitize-payload.ts`.

**Enforced by:**
- `.githooks/pre-commit` runs a secret-scan grep against staged content; PR CI runs the same at merge time.
- `scripts/sanitize-payload.ts` exports the only sanctioned placeholder constants (`oktaUserIdPlaceholder`, etc.); tests reference impl constants structurally so drift can't hide.
- Ticket template `compliance:` block specifies redaction requirements per engagement.

**Evidence customer sees:** Secret-scan CI badge green. Every fixture file in `fixtures/okta-payloads/` uses `example.com` addresses and synthetic Okta-shaped IDs.

### 5. IDEMPOTENT-TF — Terraform applies without drift

**Asserts:** The Terraform module that configures the Okta side (tenant, app instance, SCIM provisioning settings, attribute mappings) is idempotent — running `terraform plan` after `terraform apply` produces empty diff. A drifting module is a silent bug generator.

**Enforced by:**
- Pre-prod verify gate runs `terraform plan` post-deploy; the Promotion Manifest's `preprod_verify.tf_plan_empty` field is a boolean. `build.ts` refuses manifest creation if `false`.

**Evidence customer sees:** `tf_plan_empty: true` in the signed Promotion Manifest. Customer can re-run `terraform plan` themselves against their own tenant and see empty output.

### 6. SMOKE-GREEN — end-to-end lifecycle event works before promotion

**Asserts:** Post-deploy in pre-prod, the connector provisions 1 synthetic user end-to-end (Okta assignment → SCIM POST → target app row appears → PATCH `active:false` → target app row deactivates), and zero errors appear in the connector's logs during the smoke window.

**Enforced by:**
- Pre-prod verify gate runs the smoke script; Promotion Manifest's `preprod_verify.smoke_test_passed` + `log_errors_count` fields. `build.ts` refuses if smoke failed or any log errors.

**Evidence customer sees:** `smoke_test_passed: true`, `log_errors_count: 0` in the signed Promotion Manifest. Smoke-window log bundle attached to PR.

### 7. REVERSIBLE — every deploy has a named rollback

**Asserts:** Every generated connector ships a documented rollback procedure. Deploys are done against tagged git refs so a revert is `git checkout <prior-tag> && terraform apply`. No "we'll figure it out when it breaks."

**Enforced by:**
- Pre-merge checklist verifies RUNBOOK.md contains a Rollback section.
- Promotion Manifest pins `git_tag` — the exact prior-release ref is always discoverable.
- BLAST-RADIUS LAW: prod has its own workspace + ref; rollback mirrors the forward flow in reverse.

**Evidence customer sees:** RUNBOOK.md's "Rollback" section in the generated connector repo. Signed Promotion Manifest pins the `git_tag` that could be rolled back TO.

### 8. OBSERVABLE — structured logs, error pipe, health endpoint

**Asserts:** The generated connector exposes:
1. Structured JSON logs with request-ID correlation per SCIM request
2. A non-zero process exit on fatal panics (no silent-death failures)
3. A `/healthz` endpoint reporting liveness + target-app reachability

Every critical piece ships all three (OBSERVABILITY LAW, scoped to the output).

**Enforced by:**
- Skeleton includes `skeleton/logger.ts` (structured JSON, secret-redacting), `skeleton/middleware/request-id.ts` (safe correlation id with log-forging defense), and `skeleton/routes/healthz.ts` (auth-exempt, optionally probes `store.ping()`). Every generated connector inherits all three by default — see `docs/integrations/observability.md`.
- Post-deploy smoke indirectly verifies `/healthz` semantics via the SCIM surface; `buildManifest` refuses on log-error-count > 0 (caught by the logger's error level emission).
- Any behavioral claim in comments about observability is TRUTH-LAW-gated to a test.

**Evidence customer sees:** Live `/healthz` endpoint in pre-prod AND prod, 200 when target reachable / 503 when degraded. First-5-minutes post-deploy log bundle attached to PR, JSON-parseable with `jq`, zero `Bearer` tokens present (redacted by default).

### 9. RUNBOOK-COMPLETE — handoff docs match handoff reality

**Asserts:** Every generated connector ships with a RUNBOOK.md containing: env vars + their meanings, deploy steps end-to-end, rollback procedure, known limitations, on-call contact or escalation path. No tribal-knowledge-in-heads after the PS consultant hands this to the customer.

**Enforced by:**
- Pre-merge checklist verifies all six runbook sections are non-empty.
- PROD-READINESS LAW (14) covers every external integration in the connector's integration docs.

**Evidence customer sees:** RUNBOOK.md in the generated repo. The customer can deploy it from the runbook alone with no further PS involvement.

### 10. AUDIT-TRAIL — every promotion captures who, what, when, signed

**Asserts:** Every promotion from pre-prod to prod produces a signed Promotion Manifest that names (a) the exact commit, (b) the exact fixtures hash, (c) the pre-prod verify results, (d) the approver, (e) when they approved, cryptographically signed so tampering is detectable. Post-incident: "who approved this and what did they actually verify?" has a deterministic answer.

**Enforced by:**
- `scripts/promotion-manifest/` layer (HMAC-SHA256 over RFC 8785 canonical JSON, dual-key rotation window).
- Signature verification is a precondition for prod apply; `cli.ts verify` exits non-zero, deploy refuses.

**Evidence customer sees:** The signed Promotion Manifest itself, stored alongside the deployment record. Tampering detection by re-verify.

---

## The Trust Chain, End to End

```
Customer asks for SCIM onboarding of a custom app
    │
    ▼
PS consultant files a ticket from ticket-templates/new-scim-connector.md
    │
    ▼
Agent generates a connector using the harness as its context
    │       (skeleton + okta-dialect + attribute-mapping-patterns +
    │        integration docs + the 14 meta-laws for how to build right)
    ▼
PR opens; pre-commit + CI gates run:
    Law 1  (TEST-GREEN)       → vitest must be N/N
    Law 3  (DIALECT-CITED)    → TRUTH-LAW comment scan
    Law 4  (SECRETS-OUT)      → secret-scan
    Law 9  (RUNBOOK-COMPLETE) → runbook-section check
    │
    ▼
Merge → Terraform apply to staging workspace
    │
    ▼
Pre-prod verify gate runs:
    Law 1  (TEST-GREEN)  → vitest against live pre-prod
    Law 2  (OIN-12/12)   → SPEC Test suite against tenant
    Law 5  (IDEMPOTENT)  → terraform plan empty
    Law 6  (SMOKE-GREEN) → provision cycle + log error count
    Law 8  (OBSERVABLE)  → /healthz reachable
    │
    ▼
If ALL green → buildManifest composes a PromotionManifest
    (scripts/promotion-manifest/build.ts refuses on any red)
    │
    ▼
Reviewer approves → signManifest produces SignedPromotionManifest
    Law 10 (AUDIT-TRAIL) signed with HMAC-SHA256 + rotating key
    │
    ▼
Prod apply precondition: verifyManifest exits 0
    │
    ▼
Terraform apply to prod workspace — same code, different workspace
    Law 7 (REVERSIBLE) preserved: tagged ref means revert is 1 command
    │
    ▼
Customer's prod tenant provisions users via the generated connector
    Customer can read every artifact in the chain:
      - The code
      - The PR history
      - The signed manifest
      - The /healthz endpoint
    No part of the trust chain is "because we said so."
```

---

## Relationship to the 14 Meta-Laws

| 14 Meta-Laws (AGENTS.md) | 10 Connector Laws (this file) |
|---|---|
| Govern engineers BUILDING the harness | Govern OUTPUT every generated connector must satisfy |
| Enforced at development time (pre-commit, code review) | Enforced at generation + promotion time (CI, pre-prod gate, manifest builder) |
| Examples: IRON (TDD), SILVER (read docs), GATE (reviewer findings) | Examples: TEST-GREEN, OIN-12/12, AUDIT-TRAIL |
| If a law fails, the fix is to rebuild the harness correctly | If a law fails, the fix is to reject the connector until it conforms |

The two layers compound. Meta-laws make the harness itself trustworthy. Connector laws make the OUTPUT of the harness trustworthy. A customer accepting an agent-generated SCIM connector is accepting BOTH layers simultaneously, because the harness's own trustworthiness is what enables it to enforce the output gates.

---

## What the harness CANNOT enforce (and how we mitigate)

Not every trust property is enforceable by a gate. We name the gaps explicitly rather than hide them:

- **Semantic correctness of attribute mappings.** The harness can enforce that a mapping exists, that tests pass, that OIN SPEC tests pass. It CANNOT enforce that the customer's domain-specific attribute semantics are right (e.g., "employeeType=contractor" should NOT get `active: true` if the customer's policy says contractors can't access). Mitigation: human PS consultant reviews the PR's "Attribute mapping requirements" section against the ticket's business-purpose narrative. This is documented as part of the `human review checklist` in the ticket template.

- **Rightness of the decision to onboard.** The harness doesn't assess whether SCIM is the right integration pattern for this customer's app. Mitigation: ticket intake is a PS decision, not an agent decision.

- **Ongoing behavior after deployment.** The harness enforces pre-prod + prod gates at DEPLOY time. Drift after deployment (customer's target app changes schema, breaks integration) is NOT caught by the harness. Mitigation: OBSERVABILITY LAW's `/healthz` + error pipe raise alerts; periodic replay-test re-runs in prod catch schema drift. Explicitly out of hackathon scope; future work.

Naming these gaps is itself a trust act — a harness that claims to enforce everything is lying.

---

## Last updated
2026-05-05 — initial 10 Connector Laws. Introduced alongside the promotion-signing layer commit series.
