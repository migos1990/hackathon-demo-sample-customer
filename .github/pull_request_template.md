## Summary

<!-- 1-3 bullets. What changed, why. -->

## 14 Laws Self-Attestation

Every PR explicitly declares which laws it operates under. Each box either
checked with evidence, OR marked `N/A` with a one-liner why. Blank boxes block
merge per GATE LAW.

- [ ] **IRON (TDD)** — new behavior has a test written first, observed to fail first
  - Evidence: `file:line` of the test, and the commit SHA where it failed first
- [ ] **GOLDEN** — worktree checked, surface-scoped verification run
  - Verification command: `<command>`
- [ ] **SILVER** — third-party docs consulted before integration code
  - Doc URLs: `<list>` (or `N/A` + reason)
- [ ] **THIRD** — design-handoff audit done if applicable
- [ ] **OBSERVABILITY** — critical pieces have error pipe + health + smoke
  - Metric / smoke test: `<command or file:line>` (or `N/A` + reason)
- [ ] **TRUTH** — behavioral comments have tests or `UNVERIFIED` annotations
- [ ] **GATE** — any reviewer finding from a previous PR that would gate this PR is honored
- [ ] **BLAST-RADIUS** — dev/staging/prod separation preserved; no cross-env bleed
- [ ] **POSTMORTEM** — any silent failure class introduced has a detector
- [ ] **PLAN** — if >3 files or >50 lines or critical path, there's a plan cited
  - Plan doc: `<path>` (or `N/A: diff is small`)
- [ ] **EVAL** — prompt/schema change ships a golden-set run
  - Result summary: `<pass/fail counts>` (or `N/A`)
- [ ] **READ** — this PR body cites `file:line` for every code claim made
- [ ] **DATA** — data-argument claims include query + num/denom + cohort
- [ ] **PROD-READINESS** — external integration has `docs/integrations/<name>.md`
  - Doc path: `<path>` (or `N/A`)

## File:line citations

<!-- READ LAW — cite the load-bearing code paths this PR touches. -->

- `scripts/sanitize-payload.ts:<line>` — …
- `scripts/sanitize-payload.test.ts:<line>` — …

## Test plan

- [ ] `npm test` green locally
- [ ] `npm run typecheck` green
- [ ] (if integration changes) smoke test passes against staging demo tenant

## Notes for reviewer

<!-- Anything specific to look for. Call out assumptions the reviewer should challenge. -->
