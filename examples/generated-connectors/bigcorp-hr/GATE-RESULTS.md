# Harness gate results — agent-generated BigCorpHR connector

**Date:** 2026-05-05
**Gates run:** `scripts/runbook-check-cli.ts`, `scripts/dialect-citation-scan-cli.ts`
**Files scanned:** 7 .ts + 1 .md (1339 + 324 = 1663 lines total)

This file documents what happens when the real agent output (captured at `examples/generated-connectors/bigcorp-hr/`) is run through the actual harness gates. It answers the customer-trust question: "does the harness actually catch what the agent gets wrong?"

---

## Results

```
=== runbook-check ===
RUNBOOK OK: examples/generated-connectors/bigcorp-hr/RUNBOOK.md

=== dialect-citation-scan ===
DIALECT OK: 7 file(s) scanned
```

Both gates pass after a bug fix surfaced BY this exercise (see below).

---

## What the harness found (and how we fixed it)

### Initial run: runbook-check reported a false positive

First pass against the agent output:

```
RUNBOOK FAIL: examples/generated-connectors/bigcorp-hr/RUNBOOK.md
  empty sections:       deploy, rollback
```

Investigation: the agent's RUNBOOK has all 6 required sections, but uses h3 subheadings inside each h2 (e.g., `## Deployment` → `### Prerequisites` → `### Local / dev startup` → `### Staging deployment (Terraform)`). The parser at `scripts/runbook-check.ts` was treating h3 as a section boundary, so it saw `## Deployment` followed immediately by `### Prerequisites` and recorded the h2 as empty.

This was a real bug in the harness, caught BY exercising the harness against actual agent output. Fix at `scripts/runbook-check.ts`: detect the document's minimum heading depth and treat ONLY that depth as section boundaries. h3s inside an h2 become part of the h2's body.

Test coverage added: `scripts/runbook-check.test.ts` → "accepts h2 sections with h3 subheadings as content (agent-generated pattern)" — regression guard for this exact case.

After the fix, re-ran the gates → both pass.

### Second gate: dialect-citation-scan

The scanner checks that every Okta-specific code path (SCIM content-type, userName-eq filters, 00u ids, scim-patch imports, scim2-parse-filter imports, scimType:uniqueness) cites one of: `docs/okta-dialect.md`, RFC 7643/7644, developer.okta.com, help.okta.com, trust.okta.com, or an explicit UNVERIFIED annotation.

All 7 .ts files passed on first scan. Spot-check via grep:

```
$ grep -l 'okta-dialect\|RFC 764\|developer\.okta\.com' \
    examples/generated-connectors/bigcorp-hr/*.ts \
    examples/generated-connectors/bigcorp-hr/routes/*.ts
examples/generated-connectors/bigcorp-hr/mapping.ts
examples/generated-connectors/bigcorp-hr/client.ts
examples/generated-connectors/bigcorp-hr/store.ts
examples/generated-connectors/bigcorp-hr/server.ts
examples/generated-connectors/bigcorp-hr/routes/users.ts
```

The agent was instructed (via the system prompt in `scripts/orchestrator/agent/agent.ts`) that every Okta-specific line MUST cite a source. It did — reliably, across 7 files and 1339 lines. This is the DIALECT-CITED connector-law (Law 3) firing at generation time, reinforced by the lint gate at commit time.

---

## What this proves

1. **The harness catches agent mistakes when the mistakes are detectable by the gate.** When a gate has a bug (runbook-check's h3 handling), running the gate against real agent output surfaces the bug, not a silent pass.
2. **The agent follows prompt-level instructions reliably enough to pass content gates.** All 7 files cited dialect sources without manual intervention. This doesn't generalize to every instruction (we have no such claim), but for structural rules with a testable gate, the prompt+gate combo works.
3. **The trust chain is testable end-to-end.** Judges / customers / partners can re-run the CLI scripts against any agent output and verify the claim. No "trust me, the gates work" — just `npx tsx scripts/runbook-check-cli.ts <file>`.

## What this does NOT prove

- **Runtime correctness.** Dialect-citation lint proves the AGENT cited a source. It does NOT prove the source actually supports the claim the code makes. A motivated bad actor could cite `RFC 7644 §99999` (which doesn't exist) and pass the lint. Catching that needs either a docs-verifier (fetch the RFC, grep for the cited section) or a TypeScript compiler error (wrong field name → tsc fails). Today's gate is syntactic; semantic enforcement is Day 11+ work.
- **Test coverage of generated code.** The agent emitted 7 implementation files but 0 test files. Adding "generate tests for every non-test file" to the agent prompt template is a near-term follow-on. Without it, the TEST-GREEN connector-law (Law 1) is enforceable only via replay-test — which is offline.
- **Compile success.** None of the 7 files were tsc-checked (examples/ is deliberately out of tsconfig.include). Moving them into `connectors/bigcorp-hr/` would exercise tsc + require fixes if type errors exist. That's the intended pattern: the orchestrator opens a PR, CI runs tsc, red check blocks the manifest.

---

## Reproduction

```bash
cd ~/Desktop/scim-harness
npx tsx scripts/runbook-check-cli.ts \
  examples/generated-connectors/bigcorp-hr/RUNBOOK.md

npx tsx scripts/dialect-citation-scan-cli.ts \
  $(find examples/generated-connectors/bigcorp-hr -name '*.ts')
```

Both should exit 0 with "OK" in their stdout. If the agent regenerates different output in a future probe (`npx tsx scripts/orchestrator/agent/live-probe.ts --write-to examples/generated-connectors/bigcorp-hr`), re-run the same gates against the new output; any new failure is genuine content the agent missed.
