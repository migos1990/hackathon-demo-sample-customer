# Integration: GitHub Actions CI

**Law:** PROD-READINESS (14). GitHub Actions is the CI surface the orchestrator's post-pipeline composer waits on. Without a real workflow, `waitForChecks` returns `no_checks` every time and the manifest is never built.

**Workflow:** `.github/workflows/ci.yml` — runs on every PR against `main` and every push to `main`.

---

## Jobs (named to match the pre-commit hook + the post-pipeline composer's failure mapping)

| Job name | Mirrors | Gate |
|---|---|---|
| `vitest` | `.githooks/pre-commit:24-29` | IRON LAW (Law 1 meta) + TEST-GREEN (Law 1 connector) |
| `tsc` | `.githooks/pre-commit:34-43` | Typecheck (cross-cutting) |
| `secret-scan` | `.githooks/pre-commit:45-140` | SECRETS-OUT (Law 4 connector) |
| `dialect-citation (Connector Law 3)` | `.githooks/pre-commit:142-155` | DIALECT-CITED (Law 3 connector) |
| `runbook-check (Connector Laws 7+9)` | `.githooks/pre-commit:157-180` | REVERSIBLE (Law 7) + RUNBOOK-COMPLETE (Law 9) |

Every job delegates to the same script the pre-commit hook invokes. A green local commit → green CI PR. If the two ever diverge, the scripts are the source of truth; update the hook + the workflow together.

## Design decisions

**Mirror the hook, don't replicate it.** The workflow invokes the same CLI scripts (`scripts/runbook-check-cli.ts`, `scripts/dialect-citation-scan-cli.ts`). Duplicating the bash logic into YAML would produce two sources of truth that drift.

**Per-job failure names match pre-commit gate names.** The post-pipeline composer's Linear comment on a failed PR quotes the failing check names (`tsc`, `runbook-check`, etc.). A developer reading the comment can grep their local pre-commit output with the same string to reproduce.

**Fetch-depth 2 for diff-based jobs.** secret-scan, dialect-citation, and runbook-check all want to know "what changed in this PR," which requires fetching the base commit. checkout@v4's `fetch-depth: 2` covers single-commit PRs; multi-commit PRs need `fetch-depth: 0` (full history) which is slower — the current setting works for hackathon PR sizes.

**Concurrency group cancels in-progress runs.** Pushing a new commit to a PR mid-CI cancels the running batch. Prevents stale check_runs from confusing the orchestrator's `waitForChecks` (which polls GitHub's most-recent state).

## What this workflow does NOT do (yet)

- **No deploy.** Terraform apply + smoke runner fire LATER in the pipeline, driven by `runPostPipeline` reading the check results. Splitting deploy out of the PR workflow keeps PR time <5 minutes; deploy happens asynchronously to a separate staging tenant.
- **No live OIN SPEC test.** Replay-test rig (`replay-test/replay.test.ts`) covers the offline subset. Live tenant OIN run wires in when demo tenants are provisioned (Day 4-5 per `docs/hackathon-weekend-plan.md`).
- **No matrix builds.** Single Node 20 on ubuntu-latest. Adding Node 18 / 22 / macOS would be future work; hackathon scope.
- **No caching beyond npm.** `actions/setup-node@v4 cache: npm` covers the dependency install. Build artifacts aren't cached because tsc is <2s clean.

## Post-deploy verification checklist

After landing `.github/workflows/ci.yml` on `main`:

- [ ] Push a trivial test commit on a feature branch + open a PR. All 5 jobs run; all green.
- [ ] Introduce a failing test locally; push; `vitest` job fails on PR. Failure message shows the failing test name.
- [ ] Stage a `ghp_fake_token_would_be_here_30_chars_ok` literal; push; `secret-scan` job fails with `"Possible GitHub token in diff"`.
- [ ] Edit `connectors/acme-hr/store.ts` to remove dialect citations (delete the `okta-dialect.md` reference); push; `dialect-citation` job fails.
- [ ] Edit `connectors/acme-hr/RUNBOOK.md` to replace `## Rollback` content with "TBD"; push; `runbook-check` job fails.
- [ ] Orchestrator's `waitForChecks` against a real PR's head SHA returns `passed` (all 5 green) — end-to-end proves the CI watcher wire-up.

## Secrets that need to be set at the repo / org level

None for the CI workflow itself — it runs on public-facing repo state only. The orchestrator's `.env` (LINEAR_API_KEY, GITHUB_TOKEN, ANTHROPIC_API_KEY) runs OUTSIDE this workflow, on the orchestrator host machine.

If/when we add a deploy job to this workflow post-hackathon, secrets that need to land in GitHub Actions repo secrets:
- `OKTA_STAGING_TOKEN` / `OKTA_PROD_TOKEN`
- `PROMOTION_SIGNING_KEY_CURRENT` + `_ID`
- `ACME_HR_API_TOKEN` (or per-customer tokens)

## Known limitations (UNVERIFIED until probed)

- **Workflow has not been run against a real GitHub repo as of 2026-05-05.** File is syntax-valid but untested live. The first PR that lands this file IS the integration test.
- **Fetch-depth 2 assumption.** A force-push or squash-merge scenario might leave the base commit outside the fetched range; the diff commands fall back to `HEAD~1`. For deep-history PRs on a long-running branch, bump `fetch-depth` to `0` or a higher explicit number.
- **Secret-scan job's `git diff BASE...HEAD` might differ from pre-commit's `git diff --cached`.** Pre-commit sees staged content; CI sees committed. In practice they converge at commit time, but a commit that includes `--amend` changes after staging could produce different diffs. Not observed as a bug, noted as UNVERIFIED.

---

## Last updated

2026-05-05 — initial workflow + integration doc. Orchestrator CI watcher now has a real target to poll against; post-pipeline composer's `ci-no-checks` branch should no longer fire in practice.
