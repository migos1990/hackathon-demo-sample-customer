# Integration: Anthropic SDK via Okta LiteLLM

**Law:** PROD-READINESS (14). This is the orchestrator's core runtime dependency — the Claude Agent SDK calls Claude via Okta's internal LiteLLM proxy. Everything downstream fails if this integration breaks.

**Endpoint:** `https://llm.atko.ai/v1/messages` (Anthropic-native API shape) and `/v1/models` (OpenAI-compatible model listing).

**Status:** live-probed 2026-05-05 with a hackathon-scope key. Verified four Claude models and a broad multi-provider scope.

---

## Env vars

| Var | Required | Format | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | `sk-...` 25+ chars | Hackathon-scope key from Okta ML platform team. Deactivates post-event. |
| `ANTHROPIC_BASE_URL` | Yes | `https://llm.atko.ai/v1` | NO trailing slash. Append `/messages` or `/models` at call sites. |

**Handoff convention:** the key NEVER enters a source file, a commit, or a chat message. `.env` (gitignored) is the only on-disk location. Pre-commit secret-scan (`.githooks/pre-commit`) blocks `sk-*` patterns on staged content.

---

## Auth

Use the `x-api-key` header — NOT `Authorization: Bearer`. LiteLLM accepts both forms for OpenAI-compat routes, but `/v1/messages` (Anthropic-native) only honors `x-api-key` in our probes.

```
x-api-key: <ANTHROPIC_API_KEY>
anthropic-version: 2023-06-01
content-type: application/json
```

The `anthropic-version` header is REQUIRED. Without it, the proxy rejects. `2023-06-01` is the current stable version as of probing.

---

## Available models (live-verified)

Probed against `/v1/models` on 2026-05-05. Key scope is broad — all Claude families + several non-Anthropic families proxied through the same endpoint.

**Claude (primary for this project):**

| Model id | Alias ids | Use case |
|---|---|---|
| `claude-opus-4-7` | `_claude-opus-4-7` | Deepest reasoning. Use for architecture / design / review. Higher cost. |
| `claude-opus-4-6` | `claude-4-6-opus`, `_claude-opus-4-6` | Previous Opus generation. |
| `claude-opus-4-5` | `claude-4-5-opus`, `_claude-opus-4-5` | Earlier Opus generation. |
| `claude-sonnet-4-6` | `claude-4-6-sonnet`, `_claude-sonnet-4-6` | Best coding model. **Default for orchestrator.** |
| `claude-sonnet-4-5` | `claude-4-5-sonnet`, `_claude-sonnet-4-5` | Previous Sonnet generation. |
| `claude-haiku-4-5` | `claude-4-5-haiku` | Fast/cheap. Use for routing, classification, simple transforms. |

**Other models available (out of scope for this integration, noted for completeness):** `llama-4-maverick-17b`, `llama-4-scout-17b`, `mistral-pixtral-large-25-02`, Amazon `titan-*` + `nova-*`, `command-r-plus-v1`, `gpt-5.5-pro`, `gpt-5.5`, `gpt-oss-120b`, `gpt-oss-20b`.

**Orchestrator policy (locked for hackathon):**
- Default to `claude-sonnet-4-6` for connector generation.
- Escalate to `claude-opus-4-7` for architecture-review tasks the agent delegates.
- Use `claude-haiku-4-5` for trivial classification steps (e.g., validating a Linear ticket against the YAML schema) if cost/latency matter.

---

## Request shape

Live-probed happy-path payload:

```bash
curl -sS "$ANTHROPIC_BASE_URL/messages" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 32,
    "messages": [{"role": "user", "content": "Reply with exactly: pong"}]
  }'
```

Response (abbreviated):

```json
{
  "model": "claude-sonnet-4-6",
  "id": "msg_bdrk_015vv8rBE3t7iiJ6L83r64LT",
  "type": "message",
  "role": "assistant",
  "content": [{"type": "text", "text": "pong"}],
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 13,
    "output_tokens": 5,
    "total_tokens": 18,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  }
}
```

**The `msg_bdrk_*` id prefix hints at Bedrock-backed fulfillment** — LiteLLM is proxying to an AWS Bedrock Anthropic endpoint. Implications: cache-control semantics may differ from direct Anthropic API; prompt-caching behavior needs separate verification before we rely on it.

---

## Rate limits

Unknown at this time. Not probed — aggressive rate testing against a corporate endpoint is adversarial. Observed behavior during probe run: 5 sequential requests completed in <5s total with no throttling.

**Orchestrator policy:** assume 10 req/s aggregate as a soft cap. If we hit rate limits during the live demo, fall back to pre-recorded B-roll per `docs/demo-script.md` shot plan.

---

## Failure modes

| Status | Meaning | Action |
|---|---|---|
| 200 | Success | Parse `content[0].text` for text models. |
| 400 | Invalid model name OR malformed request | Call `/v1/models` to see current scope. Error body hints which field failed. |
| 401 | Missing or invalid `x-api-key` | Check env var resolves; confirm key still valid (hackathon key deactivates post-event). |
| 403 | Key valid but not scoped for this model | Use a different model from the available scope, or request broader scope. |
| 429 | Rate-limited | Back off, retry with exponential delay. Fall back to pre-recorded B-roll for live demo. |
| 5xx | Proxy transient failure | Retry with jitter. Log to stderr per structured logger; `/healthz` downstream stays green (LLM outage is the agent's problem, not the connector's). |

---

## Model selection for orchestrator code

```ts
// pseudocode — the actual binding lives in scripts/orchestrator/llm-client.ts (weekend scope)
const MODEL = process.env.ORCHESTRATOR_MODEL ?? "claude-sonnet-4-6";
const CLIENT = {
  baseUrl: mustEnv("ANTHROPIC_BASE_URL"),
  apiKey:  mustEnv("ANTHROPIC_API_KEY"),  // never logged, never echoed
};
```

Logger middleware per `skeleton/logger.ts` redacts `authorization` + `cookie` + `set-cookie` + `proxy-authorization` headers. `x-api-key` is NOT in the default redaction list — ADD IT before shipping any orchestrator code that logs requests. Until that's added, explicitly omit `x-api-key` from any log-field payload.

**Action for the orchestrator PR:** extend `SECRET_HEADER_NAMES` in `skeleton/logger.ts` to include `x-api-key` + `anthropic-version` (the version isn't secret but it's noise). Tracked as a todo here so the weekend build doesn't miss it.

---

## Post-deploy verification checklist

Run all when deploying the orchestrator to any new environment.

- [ ] `curl $ANTHROPIC_BASE_URL/models -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01"` returns 200 with a JSON list including `claude-sonnet-4-6`
- [ ] Minimal message probe returns 200 within 5s (liveness + rough latency sanity)
- [ ] Grep orchestrator logs for `sk-[A-Za-z0-9_-]{20,}` — MUST return zero matches
- [ ] Grep orchestrator logs for `x-api-key` — should only appear as `[REDACTED]` if it appears at all
- [ ] Confirm the pre-commit secret-scan catches a fake key in a staged change (stage a dummy `sk-fakefakefake...`, try to commit, verify it's blocked)
- [ ] On the hackathon-submission machine, confirm `.env` is present AND gitignored (`git check-ignore .env` exits 0)

---

## `@anthropic-ai/sdk` quirk: the `/v1` double-path

The official SDK prepends `/v1/messages` to requests internally. If you pass `baseURL: "https://llm.atko.ai/v1"` to the `Anthropic` constructor, every request hits `/v1/v1/messages` and returns 404 `{"detail":"Not Found"}`.

**Our wrapper handles this defensively** — `scripts/llm/anthropic-client.ts` strips a trailing `/v1` before passing to the SDK. Keep the `ANTHROPIC_BASE_URL` env var value as `https://llm.atko.ai/v1` (ergonomic for curl one-liners in this doc); the wrapper takes care of the SDK path semantics.

**If you ever use the SDK directly (bypassing our wrapper):**

```ts
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: "https://llm.atko.ai",   // NO /v1 — SDK appends it
});
```

Live-verified 2026-05-05 via `scripts/llm/live-probe.ts` — all three policy models (`claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5`) round-trip cleanly with first-request latency 1.8s / 2.6s / 7.7s respectively.

## Known limitations (UNVERIFIED until probed)

- **Prompt caching.** Bedrock-backed endpoint per the `msg_bdrk_*` id prefix — Anthropic's 5-minute prompt-cache TTL may behave differently. Orchestrator code that depends on caching for cost should probe cache-hit behavior explicitly before relying on it.
- **Streaming.** Not probed. `/v1/messages` supports `stream: true` in the direct Anthropic API; LiteLLM proxy MAY or MAY NOT pass through correctly. Verify before using SSE in the orchestrator.
- **Tool use.** Claude Agent SDK uses tool-use format. Not probed via this endpoint. If the hackathon orchestrator uses the Agent SDK, probe a trivial `tools`-enabled request first.
- **Rate limits.** Not characterized.
- **Region / latency.** Single-region inference likely. A demo from an unusual geography may see higher latency.

---

## Last updated
2026-05-05 — initial doc alongside the live probe that confirmed the hackathon key. Updated when orchestrator scaffolding lands with the actual client library.
