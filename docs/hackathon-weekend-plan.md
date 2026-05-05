# Hackathon Weekend Plan — External Dependencies + Orchestrator Scope

**Purpose:** ensure every external dependency (Linear, Claude Agent SDK via LiteLLM, GitHub, Anthropic API, demo tenants) is requested, obtained, and tested BEFORE the hackathon weekend. Complements the 10-day harness-build plan at `docs/superpowers/plans/2026-05-04-scim-pipeline-10day-prep.md` in the sibling `presalesInterns` repo.

**Deadline-dependent dependencies have priority.** A LiteLLM key with a 1-2 business day SLA that's requested on Friday will arrive Monday — too late for a weekend build.

---

## External dependency register

### 1. LiteLLM model-scoped key (Anthropic via Okta infra) — **BLOCKING**

| | |
|---|---|
| **What** | Anthropic Claude access via Okta's internal LiteLLM proxy at `https://llm.atko.ai/v1/messages` |
| **Why blocking** | Claude Agent SDK's entire runtime — no key = no agent |
| **Who issues** | Okta ML platform team |
| **SLA** | 1-2 business days (per earlier session context) |
| **Format** | Bearer token, model-scoped (NOT the MCP-auth key already present in the `presalesInterns` env) |
| **Action required from user** | Request today. Specify: model access for `claude-sonnet-4-6` AND `claude-opus-4-7` (belt-and-suspenders on capability vs. cost tradeoff for the weekend). Mention the hackathon. |
| **Storage** | `.env` locally (gitignored), never committed. Pre-commit secret-scan gate will catch a mis-stage. |
| **Env var** | `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL=https://llm.atko.ai/v1` |
| **Fallback if not issued in time** | Use any individual Anthropic API key (direct to anthropic.com). Demo loses the Okta-specific "internal LiteLLM" framing but still works. |

**Integration doc target:** `docs/integrations/anthropic-sdk.md` (Day 10).

### 2. Linear API access + workspace — **BLOCKING**

| | |
|---|---|
| **What** | Linear workspace where demo tickets are filed + API access to read/comment on them |
| **Why blocking** | Ticket-driven is the premise; no Linear = no pipeline |
| **Who issues** | User has personal Linear access already (Louis uses Linear); team/workspace selection is a decision, not a request |
| **SLA** | Minutes (API key self-service at linear.app/settings/api) |
| **Options** | (a) Personal Linear workspace + private team. (b) Create a hackathon-specific sandbox workspace. (c) Okta's corporate Linear if available. |
| **Recommendation** | (a) — personal workspace, dedicated team "SCIM Demo" for isolation. Zero friction, zero approval lag. |
| **Env var** | `LINEAR_API_KEY` |
| **Integration doc target** | `docs/integrations/linear.md` |

**Action required:** create an API key at Linear Settings → API → Personal API keys. Copy to local .env. Do this today — takes 2 minutes.

### 3. GitHub PAT or GitHub App — **WEEKEND-ACTIONABLE**

| | |
|---|---|
| **What** | Credentials the orchestrator uses to create branches, push commits, open PRs |
| **Why** | Agent-generated code lands as PRs (not direct-to-main) for auditability |
| **Who issues** | User (PAT) OR GitHub App if we want a cleaner "authored by bot" signal |
| **SLA** | Minutes for PAT; 10-15 min for a GitHub App |
| **Recommendation** | PAT for weekend (faster). Scope: `repo` (private), `workflow` (for CI management). Fine-grained PAT preferred if the target repo is personal. |
| **Env var** | `GITHUB_TOKEN` |
| **Scope** | Per-fork for partner distribution later; single repo for hackathon. |

**Action required:** create PAT at weekend-start. No advance prep.

### 4. Okta demo tenants — **ADVANCE-PREP**

| | |
|---|---|
| **What** | Two Okta tenants: `demo-customer-a-staging.oktapreview.com` (pre-prod) and `demo-customer-a-prod.okta.com` (prod) |
| **Why** | BLAST-RADIUS LAW (dev → staging → prod promotion) + demo beat 5 (admin UI provisioning) |
| **Who issues** | User has Okta demo-tenant provisioning access per `presalesInterns` repo's demo skill set |
| **SLA** | Seconds via self-service; minutes via the presales demo tooling |
| **Action required** | Use `/demo-provision` in presalesInterns to stand up 2 tenants, record tenant URLs + API tokens. Do this by end of Day 4 (Day 5 at latest — demo tenants are needed for live OIN SPEC runs). |
| **Env vars** | `OKTA_STAGING_TENANT_URL`, `OKTA_STAGING_TOKEN`, `OKTA_PROD_TENANT_URL`, `OKTA_PROD_TOKEN` |
| **Integration doc target** | `docs/integrations/okta-demo-tenants.md` |

### 5. Auth0 tenant — **CONDITIONAL** (dependent on Phase-1 spike outcome from the broader PS Agent plan)

| | |
|---|---|
| **What** | Auth0 tenant for Token Vault + per-phase scoped agent tokens |
| **Why** | Per-ticket scoped token scoping for the agent (security story) |
| **Status** | DEFERRED — the current hackathon SCIM pipeline does not depend on Auth0. If demo time permits, layer in; otherwise explicitly scope out. |
| **Action required** | None for hackathon. Document as "future work" if asked. |

### 6. LiteLLM MCP auth key (already present) — **NO ACTION**

| | |
|---|---|
| **What** | The MCP-auth key already in `presalesInterns` env. DIFFERENT from the model-scoped key above. |
| **Why it matters here** | Will NOT work for Agent SDK invocation — that's the model-scoped key. Mentioned to avoid confusion. |
| **Action required** | None. Do not conflate with #1. |

---

## User action items — TODAY

| Action | Owner | Blocking? |
|---|---|---|
| Request LiteLLM model-scoped key from Okta ML team | Louis | YES — 1-2 day SLA |
| Create Linear API key (personal workspace) | Louis | Effectively blocking (can defer a day, not more) |
| Confirm decision: Linear workspace choice (personal vs. corporate) | Louis | Blocking unless we default to personal |
| Confirm: are we pursuing Auth0 integration for hackathon? | Louis | Not blocking; affects final-beat narrative |
| Confirm: which GitHub repo hosts the hackathon submission | Louis | Not blocking; weekend-actionable |

Everything else is harness-side work the autonomous build can continue closing.

---

## Orchestrator architecture (hackathon weekend scope)

```
┌────────────────────┐
│  Linear workspace  │  ← Consultant files ticket from template
│  Team: SCIM Demo   │
└─────────┬──────────┘
          │ (poll every 30s OR webhook)
          ▼
┌────────────────────┐     ┌───────────────────────┐
│    Orchestrator    │────→│   Ticket Validator    │
│   (Node + Agent    │     │  validates YAML       │
│    SDK)            │     │  against schema.json  │
└─────────┬──────────┘     └───────────────────────┘
          │ valid
          ▼
┌────────────────────────────────────────┐
│   Claude Agent SDK (via LiteLLM)       │
│   Tools: read harness files, write     │
│   new connector files, run vitest,     │
│   open GitHub PR                       │
└─────────┬──────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────┐
│   GitHub PR opened                     │
│   CI runs: gate checks + tests         │
│   Label: auto-generated                │
└─────────┬──────────────────────────────┘
          │ CI green
          ▼
┌────────────────────────────────────────┐
│   Pre-prod Terraform apply             │
│   Smoke run: scripts/smoke/cli.ts      │
│   SCIM compliance validator runs       │
└─────────┬──────────────────────────────┘
          │ all green
          ▼
┌────────────────────────────────────────┐
│   buildManifest → signManifest         │
│   Human clicks "promote" in Linear     │
│   Prod Terraform apply                 │
└────────────────────────────────────────┘
```

**What the orchestrator actually is, concretely:** a single Node process that loops on Linear tickets, invokes Claude Agent SDK in a loop per ticket, coordinates GitHub + CI + Terraform + smoke + manifest, posts status updates back to Linear as comments.

Not in scope for hackathon:
- Durable per-ticket workspaces (Symphony-spec-faithful — too much to build in 48h)
- Multi-tenant orchestration (one operator's tickets at a time)
- Recovery from partial failure (manual restart is fine for demo)
- Web UI (Linear IS the UI)

---

## Weekend build sequence (48 hours)

Ordered by dependency graph, with gate closure per step.

### Friday evening (4-6 hours — kickoff + auth)

1. **Verify all 6 env vars resolve.** Spin up the orchestrator scaffold, assert each env var is readable. Refuse to start if any is missing. Pre-commit blocks on missing env var check.
2. **Linear client library.** Thin wrapper around Linear's GraphQL API: listIssues, getIssue, postComment. Integration doc `docs/integrations/linear.md`. Tests with recorded fixtures (no live Linear in tests).
3. **Claude Agent SDK skeleton.** One-shot `generate(ticketYaml): Promise<void>` that reads harness context + writes files to a worktree. Tests against a stub LiteLLM response. No real LLM calls in CI.
4. **GitHub client.** Using `octokit` — createBranch, writeFile, openPR, getCheckRuns. Integration doc `docs/integrations/github.md`.

### Saturday (10-14 hours — wire it together)

5. **End-to-end happy path for one ticket.** File a ticket manually in Linear → orchestrator picks it up → agent generates → PR opens → CI runs → pre-prod Terraform applies → smoke passes → Promotion Manifest signed → manual promote. Single file test exercising the whole sequence with stubbed externals.
6. **Live integration smoke.** Real Linear, real LiteLLM, real GitHub, real Okta staging tenant. ONE ticket processed end-to-end with real bytes on real wires.
7. **Gate-refusal flow wire.** Second ticket with the bug variant path. Orchestrator picks up, generates bugged connector, pre-prod smoke FAILS at step 3, manifest build refuses, Linear comment reports "gate refused: target-verify-deactivated — see $url." This IS demo beats 6-8 in live production.
8. **Demo-day rehearsal.** Timebox: 90 minutes. Run both happy path + gate-refusal flows with the video-capture tooling in place. Record shot list timing.

### Sunday (6-8 hours — polish + shoot)

9. **Shoot B-roll per `docs/demo-script.md`.**
10. **Edit to 2:00 with human VO.**
11. **Pre-submission checklist verify** (per `docs/submission-draft.md`).
12. **Submit.**

**Buffer:** Friday-Saturday overlap means if Linear API key or LiteLLM key arrives late Friday, we don't lose Saturday. If either blocks past Saturday noon, fall back to the non-orchestrator demo — the harness alone is already a complete story (pre-built skeleton + signed manifest + gate refusal + connector-laws) that can carry a 2-minute video without a live agent generation.

---

## Integration docs to write (Law 14 — PROD-READINESS, per external integration)

Each must cover: env vars, auth setup, rate limits, failure modes, post-deploy verification checklist. Estimated ~100-150 lines each.

| Doc | When | Owner |
|---|---|---|
| `docs/integrations/anthropic-sdk.md` | Friday evening (step 3) | autonomous build |
| `docs/integrations/linear.md` | Friday evening (step 2) | autonomous build |
| `docs/integrations/github.md` | Friday evening (step 4) | autonomous build |
| `docs/integrations/okta-demo-tenants.md` | Day 4 of pre-hack (earlier than weekend) | autonomous build |

`docs/integrations/observability.md` (landed in commit `ef910e0`) and `docs/integrations/promotion-signing.md` (landed in commit `e7f3873`) are the existing pattern these follow.

---

## Risk register

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| LiteLLM key not issued by Friday | Medium | High — blocks agent generation | Fallback: use direct Anthropic API key. Demo loses "internal infra" framing but works. Submit the request TODAY. |
| Linear API hits rate limit during live demo | Low | Low — demo uses 2-3 tickets max | No mitigation needed at this volume |
| GitHub PR creation fails during live demo | Low | Medium — breaks live integration | Pre-shoot B-roll of the PR; splice into video |
| Okta demo tenant unavailable | Low | High — breaks the admin UI shot | Two tenants provisioned; swap on failure. Pre-shoot B-roll as fallback. |
| Claude hallucinates Okta-dialect quirks | Medium | Medium — generates invalid code | DIALECT-CITED lint + tests catch at pre-commit. Visible gate refusal is ALSO the demo story. |
| Agent generation exceeds 2-minute demo budget live | High | Low — handled by edit | Pre-record generation, intercut with live promote step. `docs/demo-script.md` already assumes this. |
| Weekend participant out sick / unavailable | N/A | Medium | Solo build per submission-draft (Team Option B acknowledges possible collaborators, no dependency) |

---

## Last updated
2026-05-05 — initial weekend plan alongside the SCIM compliance validator commit. Captures external dependencies with deadline sensitivity surfaced. Next update lands when LiteLLM key status is confirmed OR the Linear workspace decision is made.
