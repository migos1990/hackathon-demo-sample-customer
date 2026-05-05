# Integration: GitHub

**Law:** PROD-READINESS (14). GitHub is the orchestrator's CI+PR surface. Every agent-generated connector lands as a PR against the harness repo; CI (the pre-commit gates + replay-test suite) runs on every PR; green/red check results drive the post-pipeline composer's smoke + manifest decision.

**Client:** `scripts/github/github-client.ts` (Octokit-wrapped, orchestrator-facing types).

---

## Env vars

| Var | Required | Format | Scope |
|---|---|---|---|
| `GITHUB_TOKEN` | Yes | `ghp_*` PAT ~40 chars, OR GitHub App token | `repo` (read + write, branches, PRs, comments, checks) |

**Token types:**
- **PAT (Personal Access Token)** — fastest to create (2 min at github.com/settings/tokens/new). Acceptable for hackathon. Associated with the creating user's identity; PRs created via a PAT appear as authored by that user.
- **GitHub App** — cleaner audit trail ("bot authored the PR"), finer-grained permissions, no human-rate-limit implications. Recommended for post-hackathon; 15 min to set up.

**Minimum PAT scopes for hackathon:** `repo` (private-repo access + branches/PRs/contents). If target repo is public, `public_repo` suffices.

**Fine-grained PAT (github.com/settings/personal-access-tokens/new):** preferred when target repo is personal. Scope: Repository permissions → Contents (Read and write) + Pull requests (Read and write) + Checks (Read).

## Handoff convention

Key NEVER in source / commit / chat. `.env` only. Pre-commit secret-scan catches `ghp_*` patterns (see `.githooks/pre-commit:62-70` — hardened in commit `7d24060`) so an accidental paste into source fails loudly.

---

## Operations (5 — orchestrator surface)

| Op | Octokit call | Used for |
|---|---|---|
| `createBranch` | `git.createRef` after `repos.getBranch` | Fork a new branch off `main` for each generated connector |
| `writeFile` | `repos.createOrUpdateFileContents` (with prefetched sha) | Commit each agent-generated file to the new branch |
| `openPr` | `pulls.create` | Opens the PR from the new branch; title = ticket-identifier + ticket-title |
| `getCheckRuns` | `checks.listForRef` | Polled by `ci-watcher.ts` until all runs terminal |
| `commentOnPr` | `issues.createComment` | Status updates on the PR + cross-link back to Linear |

All other GitHub APIs are out of orchestrator scope. Future orchestrator additions (e.g. merge after manifest signed, tag releases after prod deploy) will add `pulls.merge` and `git.createRef` for tags.

---

## Failure modes

| Status | Meaning | Client behavior |
|---|---|---|
| 2xx | Success | Returned to caller |
| 401 | Invalid / expired token | `GitHubClientError(status=401)` |
| 403 | Insufficient scope OR rate-limited | `GitHubClientError(status=403)` — caller should inspect body for rate-limit headers |
| 404 | Resource not found (branch / repo / file) | `GitHubClientError(status=404)` — `writeFile` uses this internally for "file doesn't exist yet, this is a create not an update" |
| 422 | Validation error (ref already exists, PR already open, etc.) | `GitHubClientError(status=422)` |
| 5xx | GitHub transient | `GitHubClientError(status=5xx)` — `ci-watcher.ts` retries up to 3x before declaring `error` |
| Network failure | fetch-level | `GitHubClientError` with redacted error message |

**Token redaction:** every thrown error message is scanned for the PAT value and replaced with `[REDACTED]`. Covers octokit's occasional leakage of `Authorization` headers into transport-error strings.

## Rate limits

GitHub: 5000 requests / hour for authenticated PATs. The orchestrator's typical ticket processing burns ~15 API calls per ticket (1 createBranch + N writeFile where N is 6-8 + 1 openPr + 1-2 commentOnPr) plus ~10-60 getCheckRuns calls during CI watch (once every 30s for up to 30 min).

At 5000/hr and ~75 calls/ticket, a single orchestrator instance can process ~60 tickets/hour before rate-limiting becomes relevant. Far above hackathon volume.

**Secondary rate limits** apply to commit-creation endpoints (createOrUpdateFileContents) — empirically caps around 500 commits/hour per repo. Each agent-generated connector lands as 6-8 commits, so ~60 connectors/hour bumps against the secondary limit. Not a hackathon concern; future work would batch commits via the Git Data API (createTree + createCommit) for 1 commit per connector.

## Repo conventions

For the hackathon:
- **Repo:** hosted on Okta GHE or personal GitHub (decision pending per `docs/hackathon-weekend-plan.md`)
- **Base branch:** `main`
- **Agent branch naming:** `agent/<ticket-id>-<customer-slug>-<random6>` (see `scripts/orchestrator/processor.ts:branchNameFor`)
- **PR title:** `[<ticket-id>] <ticket-title>` — or `[<ticket-id>] Agent generated empty connector — operator review required` when the agent returns zero files
- **PR body:** pre-populated with ticket link, customer slug, target tenant, terraform workspace, files count, expected next steps (CI → pre-prod → signed manifest)

## Post-deploy verification checklist

- [ ] `GITHUB_TOKEN` resolves; `gh auth status --hostname github.com` (or curl `/user`) returns the authenticated user's login
- [ ] Target repo is reachable (curl `/repos/OWNER/REPO` returns 200)
- [ ] Token scope includes: Contents r/w, Pull requests r/w, Checks r (test via `createBranch` + `writeFile` + `openPr` + `getCheckRuns` from a smoke script)
- [ ] Pre-commit secret-scan refuses a staged file containing a `ghp_*`-shaped literal — verify with `git add + git commit` against a dummy patch
- [ ] Grep orchestrator logs for `ghp_` — MUST return zero matches (redaction working)
- [ ] Bring GitHub down (block the domain); client surfaces `GitHubClientError` cleanly, orchestrator retries on next tick

## Known limitations (UNVERIFIED until probed)

- **No GitHub App support.** PAT only. A prod deployment would issue per-partner GitHub Apps for isolation (partner's orchestrator instance can only see partner's customer repos).
- **No multi-file atomic commits.** One commit per file keeps the PR history readable but creates N commits per connector. The Git Data API path (createTree → createCommit → updateRef) would land all files in a single commit; future work.
- **No PR merge path.** Orchestrator opens PRs but never merges them — a human reviewer handles merge after the signed manifest lands. Auto-merge on manifest verify is a future feature.
- **Tag creation not wired.** Prod promotion should create a `v<semver>-<customer-slug>` tag per the Promotion Manifest's `git_tag` field. Currently the tag is stamped in the manifest but not created on the remote. One `git.createRef` call adds this.
- **No re-entrancy safety on branch creation.** If a poll retries a ticket after a createBranch already succeeded, the next call returns 422 (ref exists). The orchestrator currently relies on the random-suffix branch name to avoid collisions; more robust would be to check-then-create.
- **Webhook support absent.** PR check-runs are polled, not pushed. Acceptable for hackathon CI latency; webhooks would cut the post-CI-green → smoke delay from ~30s average to <1s.

---

## Last updated

2026-05-05 — initial integration doc alongside the GitHub client commit (`22401e6`), CI watcher (`5764585`), and post-pipeline composer (`abb3f15`).
