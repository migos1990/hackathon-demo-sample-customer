# Hackapalooza Submission Draft — Symphony-for-Okta Pro Serve

**Status:** draft. Version-controlled so the submission form is never the canonical source. Iterate here up to submission day; copy-paste at the end.

**Track:** Agentic Internal Tools (also opting into Watch Party competition).

**Constraints (hard disqualifiers if missed):**
- Video ≤ 2:00
- No audio speedup anywhere
- Video share: "Anyone in this Okta group with the link can view"

---

## Problem to solve

Pro Serve builds a bespoke SCIM connector roughly once a week — five senior-consultant days each. Junior consultants miss Okta-dialect quirks (PATCH `active:false` vs DELETE, case-sensitive `userName` for OIN step 16, lifecycle-policy branching) that only surface during Okta's OIN SPEC Test suite, costing rework and customer trust. No shared harness, no pre-prod test gate, no machine-readable ticket contract. Every engagement starts from scratch.

## Our solution

**Symphony-for-Okta Pro Serve** — a ticket-driven pipeline where an AI agent generates working SCIM connectors from Linear tickets. Three parts:

1. **Hardened TypeScript harness** with a reusable SCIM skeleton that passes all 12 OIN SPEC Tests out of the box, plus Okta-dialect quirks encoded as agent context.
2. **Pre-prod → prod promotion gate** — tickets land in pre-prod against a demo tenant, pass tests, earn a signed Promotion Manifest (HMAC-SHA256, RFC 8785 canonical JSON), then human-approved deploy to prod.
3. **Partner-ready** — the harness is forkable to Okta implementation partners, with two-of-two signature required for prod promotion, so partners accelerate without touching customer prod unilaterally.

Ticket in, production-grade SCIM connector out, with blast-radius controls the whole way.

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
