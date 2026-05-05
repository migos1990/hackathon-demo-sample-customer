# SCIM Reference Landscape — Take vs. Build Memo

**Date:** 2026-05-04
**Purpose:** identify which parts of the SCIM harness we can adopt from existing reference code vs. what we must hand-roll. Replaces the "tribal knowledge fill" moat strategy (per user's 2026-05-04 clarification that direct SCIM-implementation experience is low) with a research-synthesis + empirical-capture strategy.

**Preference hierarchy for code/docs citations (SILVER LAW):**

1. **Official Okta repos** (`okta/`, `oktadev/` on GitHub) — authoritative, aligned with Okta's own product
2. **Okta official documentation** (developer.okta.com, help.okta.com) — already covered in `okta-dialect.md`
3. **RFC 7644 / 7643** — the standard itself
4. **Maintained OSS libraries** — only where the above three don't cover the gap
5. **Random / unmaintained OSS** — fallback when even option 4 doesn't fit

**Sources:** GitHub searches `org:okta+scim` (0 results), `org:oktadev+scim` (3 results), npm registry search for SCIM packages (2026-05-04), individual repo README fetches.

## The uncomfortable top-line

**Okta does NOT maintain an official TypeScript/Node SCIM server reference.** Direct probe results:

- `github.com/okta/` SCIM repos: **0** (zero official SCIM code at the okta org)
- `github.com/oktadev/` SCIM-related repos: **3** total, all with significant limitations (see §1 below)

This means our harness cannot simply fork an official Okta reference. The best-case path is:

1. Study `oktadev/okta-enterprise-ready-workshops` (the newest official-ish Okta SCIM material) for patterns Okta blessed, even if marked "not production-ready"
2. Cross-reference against `oktadev/okta-scim-beta` (outdated Python, but the README carries historical intent statements that remain authoritative)
3. Compose with 3-4 well-maintained OSS primitives for the parts Okta doesn't provide (PATCH engine, filter parser, message envelopes, capture rig)
4. Hand-roll the Okta-dialect glue (the harness's actual moat)

If Okta ships an official TypeScript SCIM reference during our 10-day window, **it supersedes this plan immediately** — vendor-in is always cheaper than compose-and-maintain.

---

## §1 — Official Okta SCIM surface (in preference order)

### 1.1 `oktadev/okta-enterprise-ready-workshops` — closest-to-official TypeScript

- **Repo:** <https://github.com/oktadev/okta-enterprise-ready-workshops>
- **Latest push:** 2026-03-02 (recent)
- **License:** Apache 2.0
- **Maintainer:** OktaDev (Okta Developer Relations) — officially Okta
- **Stack:** TypeScript (91.9%) + React + Express + Prisma + Nx monorepo. **Matches our stack choice.**

#### 🔴 AMENDMENT 2026-05-04: SCIM workshop code does NOT exist in this repo

Full-history clone + search executed 2026-05-04 as part of Day 3 Step 1 (the SILVER LAW pass that was supposed to seed our skeleton). Findings:

- The repo contains a base todo app (React frontend + Express API + Prisma + Nx). Stack matches ours. Good.
- `grep -r "scim"` across all TypeScript/Markdown/JSON files returns **only the README**. No SCIM handlers, no SCIM routes, no SCIM tests anywhere in the tree.
- `git log --all --oneline` shows the entire commit history: `base todo app` → `OIDC completed` → `Revert "OIDC completed"` → dep updates. Every substantive commit is non-SCIM. OIDC was briefly completed, then deliberately reverted. SCIM was never committed.
- The README does mention SCIM — as one of four workshop topics — but the workshop itself is delivered separately (probably via Okta-hosted workshop sessions). **The repo is a teaching scaffold, not a reference implementation.** The workshop produces SCIM code interactively; none is committed.

**What this means for our Day 3 plan:**

- The §4 "Day 3 plan update" step "clone + read the SCIM workshop app" resolves to *"clone the repo, confirm no SCIM code exists, move on."* Done.
- We cannot crib patterns Okta blessed because Okta didn't commit any. The curriculum naming (workshop #2: SCIM) tells us Okta considers SCIM a first-class teaching topic for enterprise readiness, but that's not actionable for implementation.
- Confirmation: **there is no official Okta TypeScript SCIM reference in any public GitHub repo.** Our compose-and-hand-roll plan in §2+§3 stands unchanged as the only viable path.

- **Original expectation (preserved for audit):** study the SCIM workshop app, document what patterns Okta blessed, amend take-vs-build plan if needed. Resolved: nothing to study; plan stands.

### 1.2 `oktadev/okta-scim-beta` — historical Python 2.7 reference

- **Repo:** <https://github.com/oktadev/okta-scim-beta>
- **Latest meaningful activity:** mid-2010s (long dormant)
- **License:** MIT
- **Stack:** Python 2.7 Flask (does not support Python 3)
- **Critical disclaimer (verbatim from README):** *"Okta's SCIM implementation is much more refined since this project was put together"*
- **Value:** the README's feature-coverage list IS an authoritative statement of Okta's SCIM requirements at the time, and most of those requirements have only grown stricter. Specific still-valid claims:
  - "DELETE /Users/{id} is NOT supported — Okta uses PATCH `active: false`" — confirms our `okta-dialect.md` §3
  - "email shouldn't be used as unique identifier" — input for ticket template's `userName` field policy
  - "externalId filtering is recommended" — validates `okta-dialect.md` §11.5 externalId semantics
  - "custom attributes require attribute mapping configuration in Okta" — validates our ticket template's `attribute_mapping` field
- **Take strategy:** cite the README's intent statements in `okta-dialect.md` where they corroborate our claims. Do NOT port the Python code — stale, and our stack is different.

### 1.3 `oktadev/okta-net-scim-example` — .NET sample, wrong stack

- **Repo:** <https://github.com/oktadev/okta-net-scim-example>
- **Latest push:** 2024-02-29
- **License:** likely MIT (verify on fetch)
- **Stack:** .NET — not transferable to our TypeScript harness
- **Value:** low for us. Cross-stack reference only — if a pattern appears here AND in the TypeScript workshops repo, it's Okta's preferred way of doing that thing.

### 1.4 `okta/okta-sdk-nodejs` — calls TO Okta, not a SCIM server

- **Not applicable.** This SDK is for calling the Okta Management API from Node code (e.g., admin operations). It's not a SCIM server. Mentioned here only to rule out.

### 1.5 Why we cannot stop at official Okta sources alone

None of the above gives us:
- A production-quality PATCH engine (scim-beta's is Python; workshops' is demo-grade)
- A rigorous RFC 7644 §3.4.2.2 filter parser (workshops' is pedagogical)
- Pre-built message envelopes (ListResponse, Error, PatchOp) as typed TypeScript code
- A plug-and-play local SCIM capture sink

These four gaps are what §2 below fills with maintained OSS primitives.

---

## §2 — OSS primitives that fill the gaps left by official Okta code

Four OSS dependencies save ~4-5 days of Day 3-4 work:

| Pick | Version | License | Why |
|------|---------|---------|-----|
| **scim-patch** | v0.9.0 (2026-03-18) | Unlicense (public domain) | PATCH is the highest-risk primitive to hand-roll; this library gets it right per RFC 7644 §3.5.2 |
| **scim2-parse-filter** | v0.3.0 (2026-03-18) | MIT | Filter parser for RFC 7644 §3.4.2.2; second-most-error-prone primitive |
| **scimmy** (Messages + Schemas subset only) | v1.3.5 (2025-03-05) | MIT | Schema envelopes, ListResponse shape, error-body envelopes. Skip its full server framework. |
| **scimit** | v1.4.1 (2026-04-02) | ISC | Pre-built SCIM sink for Day 3 empirical capture. `npx scimit` + Okta demo tenant = free fixtures. |

What we hand-roll (the moat):

- **Okta-dialect glue** — case-sensitivity policy enforcement (§2 of `okta-dialect.md`), PATCH-deactivation → `lifecycle_policy` routing (§3), tenant-routing (the five-way reconciliation from PS Agent §6.7 if we graduate beyond demo tenants), HMAC Plan integrity if we add approval-gated apply
- **Customer-attribute-mapping layer** — reads the ticket template's mapping config, applies transforms, branches on customer policy
- **Replay-test runner** — replays `fixtures/okta-payloads/` against a generated server, asserts semantic equivalence
- **Validators** — SCIM compliance, security (auth on every endpoint, no PII in logs, rate limiting), Terraform baseline
- **Terraform Okta module** — no OSS library does this the way we need

Estimated combined save: skeleton drops from 3 days (Day 3 of plan) to ~1.5 days — compose the above + hand-roll the routing shell.

---

## §3 — Full OSS candidate survey

Ordered by relevance. `[TAKE]` / `[PARTIAL]` / `[SKIP]` annotations. Every pick here is a FALLBACK from §1 — if Okta ships an official TypeScript SCIM reference, drop the corresponding pick.

### `[TAKE]` scim-patch — thomaspoignant

- **Repo:** <https://github.com/thomaspoignant/scim-patch>
- **Latest:** v0.9.0 (2026-03-18); **47 releases** historically; still active
- **License:** Unlicense (public domain — no attribution required, permissive beyond MIT)
- **Maintainer:** Thomas Poignant (reputable contributor; also maintains `scim2-parse-filter` below)
- **API surface:**
  - `patchBodyValidation(scimBody)` — validates a PATCH request envelope, throws on invalid
  - `scimPatch(resource, patch, options?)` — applies the patch operation to a resource
- **RFC 7644 §3.5.2 coverage:**
  - All three ops: `add`, `remove`, `replace`
  - Filter paths: `path: 'addresses[type eq "work"].country'` supported
  - Multi-valued attrs: arrays of objects (emails, roles, addresses)
  - `treatMissingAsAdd` option — default `true` (replace-missing-as-add); set `false` for strict RFC compliance
- **Framework coupling:** NONE. Pure functions. Drop into Express/Hono/Fastify trivially.
- **Test coverage:** has `/test` dir, Coveralls badge, Sonarcloud quality tracking
- **Take strategy:** use wholesale. Wrap in our router layer. This handles §1 of the dialect doc's PATCH complexity.

### `[TAKE]` scim2-parse-filter — thomaspoignant (fork of nazoking/scim2-filter)

- **Repo:** <https://github.com/thomaspoignant/scim2-parse-filter>
- **Latest:** v0.3.0 (2026-03-18)
- **License:** MIT
- **Maintainer:** same as scim-patch (consistency bonus)
- **Why the fork:** "fork of scim2-filter v0.2.0 with bug correction" — the original was stale since 2019
- **Coverage:** RFC 7644 §3.4.2.2 grammar (eq/ne/co/sw/ew/pr/gt/ge/lt/le + and/or/not + complex attribute filters)
- **Take strategy:** use wholesale for filter parsing. Wrap to apply the §2 case-sensitivity policy at evaluation time (not parsing time).

### `[PARTIAL]` scimmy — scimmyjs

- **Repo:** <https://github.com/scimmyjs/scimmy>
- **Latest:** v1.3.5 (2025-03-05)
- **License:** MIT
- **Maintenance:** 546 commits on main, 15 releases, 7 open issues — actively maintained
- **Scope:** "building blocks, not a complete server framework" — provides `SCIMMY.Schemas`, `SCIMMY.Messages`, `SCIMMY.Resources`, `SCIMMY.Types`
- **Company on Express:** `scimmy-routers` v1.3.2 (Jan 2025). Hono alternative: `scimmy-hono-routers` v0.1.1 (March 2026).
- **Caveat:** "SCIMMY has been tested against Microsoft Entra ID (formerly Azure AD)" — **NOT** against Okta. This is the single biggest risk in adopting it for OUR use case: it might pass Entra's SCIM flow but diverge from Okta's quirks (e.g., case sensitivity, the OIN test suite's specific assertions).
- **Take strategy:**
  - **Take:** `SCIMMY.Messages` for ListResponse / Error / PatchOp envelope shapes, `SCIMMY.Schemas` for core User + Group schemas.
  - **Skip:** the full `SCIMMY.Resources` handler framework. It imposes opinions about ingress/egress/degress that might conflict with our customer-attribute-mapping layer and the lifecycle_policy branching.
  - **Skip:** scimmy-routers. Our routing is ~40 lines of Express; not worth the dependency.

### `[TAKE for Day 3 capture]` scimit — royletron

- **Repo:** <https://github.com/royletron/scimit>
- **Latest:** v1.4.1 (2026-04-02)
- **License:** ISC
- **What it does (verbatim from README):** "captures, stores, and beautifully displays every provisioning request your IDP fires at you"
- **Setup:** `npx scimit` → dashboard at `http://localhost:3088`. Default port 3088; `--port` customizable.
- **Okta-tested:** YES — README includes "Okta: Applications → [Your App] → Provisioning → Integration → Configure API Integration"
- **Day 3 plan update:** instead of hand-building an Express echo-server to capture Okta payloads, run `npx scimit`, expose via ngrok, configure the Okta demo tenant to POST to it, run the full lifecycle (create/PATCH active:false/reactivate/group-push), export captured payloads as fixtures.
- **Limitation:** README doesn't document export formats (HAR/.http). We may need to scrape scimit's storage layer (it's TypeScript, 97.9%) to extract the raw payloads into our fixture format. Worst case: 2 hours of post-processing instead of an evening of building the echo-server. Still massively positive.

### `[covered in §1.2]` oktadev/okta-scim-beta

See §1.2 — promoted to the Official Okta Surface section since it is the closest thing to an authoritative reference (even if outdated). Cited from `okta-dialect.md` §11 as a corroboration source for our existing claims.

### `[SKIP]` scimgateway — jelhub

- **Repo:** <https://github.com/jelhub/scimgateway>
- **Latest:** v6.1.18 (2026-04-22) — very actively maintained
- **Scope:** "SCIM protocol as a gateway for user provisioning to other endpoints" — multi-backend fan-out pattern
- **Why skip:** too opinionated. Assumes you're federating to many downstream systems. Our scope is one customer app per generated server. Dependency cost > value.

### `[SKIP]` @better-auth/scim

- **Scope:** SCIM plugin for Better Auth framework
- **Why skip:** framework-coupled. Our generated servers are freestanding Express apps, not Better Auth instances.

### `[SKIP]` scim2-node — UniWrighte / GluuFederation

- **Latest:** v3.0.1 (2019), v2.2.2 on npm. UNMAINTAINED for 5+ years.
- **Why skip:** stale. scim-patch + scim2-parse-filter + scimmy together cover what this tried to do.

### `[CONSIDER as alternative]` scim2-ast — woodenconsulting

- **Repo:** <https://github.com/woodenconsulting/scim2-ast>
- **Latest:** v0.3.2 (2026-02-09)
- **Angle:** filter parser with extended operators (`in`, `nin`, `any`, `all`) beyond RFC 7644
- **Why consider:** if a future customer's source-schema query layer needs richer semantics than RFC provides. For now, stick with scim2-parse-filter; cleaner RFC adherence.

---

## §4 — Day 3 plan update (post-landscape)

Pre-landscape plan was "build SCIM 2.0 server skeleton + replay test runner in 3 days." Post-landscape:

**Day 3 (revised):**
1. **FIRST (before any code): clone + read `oktadev/okta-enterprise-ready-workshops` SCIM workshop app.** Document what patterns Okta blessed. If it materially diverges from our take-vs-build plan, amend the plan before writing code. (30-60 min.)
2. **Morning:** install deps — `scim-patch`, `scim2-parse-filter`, `scimmy` (just use `SCIMMY.Schemas` + `SCIMMY.Messages`)
3. **Morning:** hand-roll router shell (~40 lines Express) that wires:
   - `POST /Users` → our create handler (customer-schema-aware)
   - `GET /Users` → filter via `scim2-parse-filter`, paginate, return `SCIMMY.Messages.ListResponse`
   - `GET /Users/{id}` → lookup handler
   - `PATCH /Users/{id}` → `scim-patch.scimPatch()` + lifecycle_policy routing
   - similar for `/Groups` (enable per ticket.required_ops.groups flag)
   - `/ServiceProviderConfig`, `/Schemas`, `/ResourceTypes` → static returns with capability flags
4. **Afternoon:** replay-test runner — Vitest suite that boots server, replays fixtures, asserts semantic equivalence on responses
5. **Afternoon:** first red-green cycle — run the 3 existing synthetic fixtures from Day 2 through the skeleton, make them green
6. **Evening:** **empirical capture via scimit** (runs in parallel with skeleton polish)

**Day 4 (revised):** demo tenants (unchanged) + feed captured payloads through the sanitizer and into fixtures; expand replay suite to 10-15 fixtures.

Net: Day 3-4 compresses. Day 5 becomes "polish + edge cases" rather than "more captures."

---

## §5 — What to install next session (Day 3)

```bash
cd ~/Desktop/scim-harness
# In the package.json at runtime dependencies (not devDependencies):
npm install scim-patch scim2-parse-filter scimmy express
# Day 3 capture rig (can be run without installing — just `npx scimit`)
# No install needed; runs ephemerally via npx
```

Add integration docs per PROD-READINESS LAW:
- `docs/integrations/scim-patch.md` — how we use it, version pin rationale, upgrade policy
- `docs/integrations/scim2-parse-filter.md` — same
- `docs/integrations/scimmy-subset.md` — which parts we use, why we skip `SCIMMY.Resources`
- `docs/integrations/scimit-capture.md` — how to run the Day 3 capture flow against a demo tenant

These four integration docs get written alongside the code on Day 3.

---

## §6 — SILVER LAW citations

Every claim above is grounded in:

- **GitHub searches** (via api.github.com, 2026-05-04): `org:okta+scim` → 0 results; `org:oktadev+scim` → 3 results (okta-scim-beta, okta-enterprise-ready-workshops, okta-net-scim-example)
- **Okta official repo READMEs** (fetched 2026-05-04) — §1 above
- **npm registry metadata** (fetched via `registry.npmjs.org/-/v1/search` on 2026-05-04) — §3 below
- **Individual OSS repo READMEs** for each candidate (fetched 2026-05-04)
- **RFC 7644 / 7643** for the feature baselines
- **`docs/okta-dialect.md` v1.1** for Okta-specific requirements our picks must honor

No candidate was evaluated on reputation or hearsay — every "take" decision has an explicit rationale tied to the above.

---

## §7 — Appendix: risk + mitigation for each take

| Pick | Risk | Mitigation |
|------|------|------------|
| scim-patch | Maintainer burnout (single individual) | 47-release history + active CI suggests stable. Fork on pin if it stalls; the code is small enough to vendor. |
| scim2-parse-filter | Same maintainer as scim-patch → correlated risk | Acceptable — if one dies the other dies; vendor both together if needed. |
| scimmy | Tested against Entra, NOT Okta | Use only `SCIMMY.Schemas` + `SCIMMY.Messages` (envelope shapes — RFC-stable). Skip the handler framework where Entra-specific assumptions might hide. Our replay suite against Okta fixtures catches any drift. |
| scimit | Export format undocumented | Day 3 morning spike: verify we can extract raw payloads in a reproducible format. If no — 2 hours to script an extractor from its storage. |
| All | NPM supply-chain compromise | Pin exact versions in package.json; commit package-lock.json (already done); run `npm audit` weekly. |

---

**Next:** on Day 3, install the four deps + write the per-dep integration docs + build the skeleton around them. This memo itself becomes a citation target for each of those integration docs.
