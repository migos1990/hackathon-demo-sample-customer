#!/usr/bin/env node
/**
 * Live probe — uses the real wrapper against the real LiteLLM endpoint.
 * Reads ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL from env (source .env first).
 *
 * Usage:
 *   eval "$(grep -E '^(ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL)=' .env | sed 's/^/export /')"
 *   tsx scripts/llm/live-probe.ts
 *
 * Exit 0 on successful round-trip, non-zero otherwise. Does NOT echo the
 * api key. Prints model id, token counts, and the first 200 chars of the
 * response text.
 */
import { fromEnv } from "./anthropic-client.js";
import { DEFAULT_MODEL, FAST_MODEL, REASONING_MODEL, type ClaudeModel } from "./types.js";

async function main(): Promise<void> {
  const client = fromEnv();
  // Probe default + reasoning + fast to confirm all three scopes work.
  const models: ClaudeModel[] = [DEFAULT_MODEL, REASONING_MODEL, FAST_MODEL];
  let allOk = true;

  for (const model of models) {
    try {
      const start = Date.now();
      const res = await client.generate({
        model,
        maxTokens: 16,
        messages: [{ role: "user", content: "Reply with exactly one word: pong" }],
      });
      const durationMs = Date.now() - start;
      const text = res.text.length > 200 ? res.text.slice(0, 200) + "…" : res.text;
      // eslint-disable-next-line no-console
      console.log(
        `✓ ${model.padEnd(22)} ${durationMs.toString().padStart(5)}ms  ` +
          `in=${res.inputTokens} out=${res.outputTokens}  text=${JSON.stringify(text)}  stop=${res.stopReason}`,
      );
    } catch (err) {
      allOk = false;
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`✗ ${model.padEnd(22)} ${msg}`);
    }
  }

  process.exit(allOk ? 0 : 1);
}

void main();
