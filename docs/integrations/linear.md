# Integration: Linear

**Law:** PROD-READINESS (14). Linear is the orchestrator's ticket source — the primary human→agent interface. Every new SCIM-connector request starts as a Linear ticket filed from the template at `ticket-templates/new-scim-connector.md`.

**Endpoint:** `https://api.linear.app/graphql` (GraphQL, single URL).

**Client:** `scripts/linear/linear-client.ts` (raw fetch + GraphQL, no SDK).

---

## Env vars

| Var | Required | Format | Notes |
|---|---|---|---|
| `LINEAR_API_KEY` | Yes | `lin_api_*` ~40 chars | Personal API key from linear.app/settings/api. User-scoped; do NOT share between engineers. |

**Handoff convention:** key NEVER enters a source file, commit, or chat. `.env` (gitignored) is the only on-disk location. Pre-commit `sk-*`-style secret scan doesn't catch `lin_api_*` patterns — this is on the diff-review step. Future work: extend `.githooks/pre-commit` to add a `lin_api_` pattern.

## Auth quirk (pay attention)

Linear's API uses the `Authorization` header with the **raw key value** — NO `Bearer ` prefix. This differs from Anthropic (`x-api-key`), GitHub (`Bearer`), and almost every other API we integrate with.

```
Authorization: lin_api_xxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
```

Getting this wrong returns 401 with a misleading error message. The client at `scripts/linear/linear-client.ts` handles this correctly; callers of the client never see the raw header.

---

## Operations (4 — the full orchestrator surface)

| Op | GraphQL | Used for |
|---|---|---|
| `listIssuesByTeam` | `query Issues(filter: {team,state})` | Polling loop — fetch tickets in state `triage` or `unstarted` |
| `getIssue` | `query Issue(id)` | Fetch full description for per-ticket processor |
| `commentOnIssue` | `mutation commentCreate` | Status updates back to the ticket (validation errors, PR link, manifest signature) |
| `updateIssueState` | `mutation issueUpdate` | Advance state (Triage → In Progress → Done) |

All other Linear APIs (Cycles, Projects, Attachments, Views) are out of scope.

---

## Failure modes

| Status | Meaning | Client behavior |
|---|---|---|
| 200 + `data.xxx` present | Success | Returned to caller |
| 200 + `errors[]` non-empty | GraphQL-level error (permissions, invalid query) | `LinearClientError` with concatenated messages |
| 401 | Invalid API key | `LinearClientError(status=401)` |
| 429 | Rate limited | `LinearClientError(status=429)` — caller decides backoff |
| 4xx other | Validation / scope | `LinearClientError(status=...)` with redacted body |
| 5xx | Linear outage | `LinearClientError(status=5xx)` — retry on next orchestrator poll |
| Network failure | fetch() threw | `LinearClientError` with redacted error message |

**Key redaction:** every thrown error message is scanned for the API key value and replaced with `[REDACTED]`. Covers the case where the fetch layer bakes the Authorization header into transport-level error strings.

## Rate limits

Linear documents the GraphQL API as `1500 requests / hour` per API key. The orchestrator's default poll interval of 30 seconds = 120 polls/hour = well under. Each poll triggers 1-5 calls (listIssuesByTeam + 0-4 per-ticket commentOnIssue/updateIssueState). Comfortable.

If we ever get rate-limited: 429 response surfaces cleanly through `LinearClientError` and the orchestrator's per-ticket error isolation means the loop keeps going on the next tick.

## Workspace + team setup

For the hackathon:
- **Workspace:** personal Linear workspace (Louis's). Zero approval lag.
- **Team:** create a dedicated team named `SCIM` (or similar) with its own key. The orchestrator's `ORCHESTRATOR_TEAM_KEY` env var pins which team it polls; tickets in other teams are ignored.
- **States:** Triage → In Progress → Done (+ Canceled for schema-violated tickets). Fetch state UUIDs once, set in env as `ORCHESTRATOR_INPROGRESS_STATE_ID`, `ORCHESTRATOR_DONE_STATE_ID`, `ORCHESTRATOR_CANCELED_STATE_ID`. The orchestrator does NOT auto-create states.

## Post-deploy verification checklist

- [ ] `LINEAR_API_KEY` resolves; `curl https://api.linear.app/graphql -H "Authorization: $LINEAR_API_KEY" -d '{"query":"{viewer{name email}}"}' | jq` returns your name + email
- [ ] Create a test ticket in the configured team; `listIssuesByTeam` surfaces it within one poll cycle
- [ ] `commentOnIssue` posts a visible comment on the ticket
- [ ] `updateIssueState` moves the ticket to a different state (and back, to reset)
- [ ] Grep orchestrator logs for `lin_api_` — MUST return zero matches (redaction working)
- [ ] Kill Linear network path mid-poll (block the domain); client surfaces `LinearClientError` cleanly, orchestrator loop continues

## Known limitations (UNVERIFIED until probed)

- **Webhooks not wired.** The orchestrator polls every 30s instead of subscribing to Linear's webhook. Webhook support halves the end-to-end latency (ticket-filed → agent-invoked) but adds inbound-HTTPS infrastructure. Deferred.
- **Attachments on comments not supported.** Agent failures > 100KB get truncated in comment bodies. Future: upload as an attachment.
- **Multi-team polling not supported.** One team per orchestrator instance. Running N instances is the workaround; proper multi-team support needs shared dedup state (the `history` Map is per-process).
- **State UUIDs are pinned via env vars.** A team rename or state deletion breaks the orchestrator silently — it'd start failing `updateIssueState` calls. Future: auto-discover state UUIDs from team config + warn on mismatch.

---

## Last updated

2026-05-05 — initial integration doc alongside the Linear client commit (`6c96969`) and the orchestrator main loop (`3718bdb`).
