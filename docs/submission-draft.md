# Hackapalooza Submission Draft — Symphony-for-Okta Pro Serve

**Status:** draft. Version-controlled so the submission form is never the canonical source. Iterate here up to submission day; copy-paste at the end.

**Track:** Agentic Internal Tools (also opting into Watch Party competition).

**Constraints (hard disqualifiers if missed):**
- Video ≤ 2:00
- No audio speedup anywhere
- Video share: "Anyone in this Okta group with the link can view"

---

## Problem to solve

When a customer has a custom in-house or niche third-party app without an out-of-the-box Okta OIN connector and asks Pro Serve to onboard SCIM provisioning quickly, the engagement historically takes a senior consultant ~5 days because so much can go wrong silently: PATCH `active:false` vs DELETE semantics, case-sensitive `userName` (OIN step 16), lifecycle-policy branching, attribute-mapping edge cases, idempotent Terraform, credential hygiene. Junior consultants miss these quirks until Okta's OIN SPEC Tests fail in UAT — costing rework, schedule slip, and customer trust. There is no shared harness, no pre-prod verify gate, no machine-readable ticket contract, and no cryptographic audit trail for what actually shipped to the customer's prod tenant.

## Our solution

**Symphony-for-Okta Pro Serve** — a ticket-driven pipeline where an AI agent generates a working SCIM connector for a customer's custom app from a Linear ticket, with the rigor of senior-consultant review encoded once as harness gates instead of re-learned every engagement. Four parts:

1. **Hardened TypeScript harness** — reusable SCIM skeleton that already passes all 12 Okta OIN SPEC Tests, plus `docs/okta-dialect.md` capturing the dialect quirks that bite in production, fed to the agent as grounded context.
2. **Two layers of enforced laws.** 14 meta-laws govern how we BUILD the harness (TDD, official-doc citation, blast-radius isolation). 10 connector-laws govern what every GENERATED connector OUTPUT must satisfy (TEST-GREEN, OIN-12/12, DIALECT-CITED, SECRETS-OUT, IDEMPOTENT-TF, SMOKE-GREEN, REVERSIBLE, OBSERVABLE, RUNBOOK-COMPLETE, AUDIT-TRAIL), each mechanically enforced by a harness gate. Trust doesn't come from trusting the agent — it comes from gates the agent cannot bypass.
3. **Pre-prod → prod promotion gate with signed manifest** — ticket lands in pre-prod against a demo tenant, passes verify gates, earns a signed Promotion Manifest (HMAC-SHA256 over RFC 8785 canonical JSON) pinning commit + fixtures hash + verify results + approver, then human-approved deploy to prod. "We tested it in staging" becomes a cryptographic assertion.
4. **Partner-ready** — same harness forkable to Okta implementation partners, with two-of-two signature required for prod promotion so partners accelerate without touching customer prod unilaterally.

Ticket in → production-grade SCIM connector out, faster than hand-rolled and with trust properties a hand-rolled connector rarely has.

## Team members we're looking for

Solo-led build. Open to collaborators on: (1) video production for the 2-min demo (shot list, cuts, VO), (2) Terraform + demo-tenant configuration for the live staging→prod gate, (3) Claude Agent SDK wiring for the hackathon-weekend orchestration layer. Ideal if you've built with Agent SDK against LiteLLM, or if you've shipped Okta OIN integrations and want to pressure-test the dialect doc.

## Implemented vs Simulated

**~60% implemented / ~40% simulated** at submission.

**Implemented:**
- TypeScript SCIM harness with full skeleton (Users CRUD, filter, pagination, PATCH via `scim-patch`, error envelope, bearer auth)
- 62 passing tests including replay-suite against Okta SPEC-equivalent fixtures; OIN 12/12 coverage via replay rig
- Machine-readable ticket template + JSON Schema with `promotion_gate` block
- `docs/okta-dialect.md` with RFC + Okta-official-doc citations across 12 sections
- 14-law pre-commit gate + PR template
- AcmeHR-lite mock target app (Express + SQLite SCIM server with an admin UI that shows provisioning land in real time)
- Demo tenants provisioned, Terraform config for staging + prod workspaces
- One end-to-end connector generation demo (ticket → agent → tests green → pre-prod deploy → signed manifest → prod)

**Simulated:**
- Promotion Manifest signing works for the demo path (one-shot); key rotation cron + multi-approver UI are spec'd, not built
- Partner distribution is documented and architected; no partner onboarding tooling, no shared Terraform backend
- Linear orchestration is wired for one happy-path flow via Claude Agent SDK; polish, error-recovery, and durable workspace-per-issue persistence are deferred
- Observability is structured-logging only; error pipe + health metrics + smoke tests documented but not dashboarded
- Auth0 Token Vault per-ticket token scoping is stubbed; full feasibility would require the Phase -1 spike from the broader PS Agent roadmap

---

## Project assets

| Field | Value | Owner |
|---|---|---|
| Link (code/docs) | TODO: decide host (Okta GHE / public GitHub / internal GitLab) and push before shoot day | Louis |
| Video | TODO: capture + Drive upload with Okta-group share scope | post-production |

## Submission questions

| Question | Answer | Owner |
|---|---|---|
| Watch Party availability (select all that work + async) | TODO: tick every slot that works + also tick async (losing nothing by opting into both) | Louis |
| % implemented vs simulated | See "Implemented vs Simulated" section above — 60/40 projected | — |
| Comments (optional) | "Track submission for Agentic Internal Tools — interested in PS-tooling roadmap feedback." | — |

## Pre-submission checklist (run before hitting submit)

- [ ] Video is ≤ 2:00 measured in the final upload, not the edit timeline
- [ ] No audio speedup anywhere in the final cut (including montage segments)
- [ ] Video share permission set to the Okta group scope (not public, not restricted-specific-users)
- [ ] Code link resolves for anyone with the Okta group link (mirror perms)
- [ ] All four Description fields filled (Problem / Solution / Team / Implemented-vs-Simulated)
- [ ] Watch Party slots selected (at least one or async)
- [ ] Implemented/Simulated % consistent between the public Description field and the private Submission Question

## Open items (need Louis to decide)

1. **Code hosting target.** Where does `scim-harness` live at submission? Options: Okta GHE private repo, public GitHub, internal GitLab. Affects link share semantics. Lock by end of Day 4.
2. **Watch Party slots.** User has schedule visibility; I don't. Rec: tick every slot that works + async.
3. **Judging rubric depth.** Hackathon page summarizes "Project requirements / Video / Project categories / Theme" — is there a fuller rubric document? If yes, grab the link and we'll re-check the submission draft against it. If no, we default to the track's stated value (PS-tooling roadmap influence).

## Revision log

- 2026-05-05: initial draft committed. Copy ready, assets + Watch-Party selection pending.
