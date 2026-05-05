/**
 * Real Agent implementation — the brain of the orchestrator.
 *
 * Flow:
 *   1. Pick a pattern key from ticket.user_model_source (ldap today;
 *      workday + custom-db when those patterns fill).
 *   2. Load harness context (dialect doc + pattern doc + skeleton
 *      files + reference connector) via loadHarnessContext.
 *   3. Build a system prompt with the context + an output-format spec,
 *      and a user prompt with the ticket YAML.
 *   4. Call the AnthropicClient.
 *   5. Parse the response via parseAgentOutput (structured block
 *      format, path-safety-checked).
 *   6. Return GeneratedFile[].
 *
 * Not yet implemented: retries on transient LLM errors, context
 * trimming for large tickets, tool-use for iterative refinement.
 * These are hackathon-weekend-polish work.
 */
import type { AnthropicClient } from "../../llm/anthropic-client.js";
import { DEFAULT_MODEL, type ClaudeModel } from "../../llm/types.js";
import { parseAgentOutput } from "./output-parser.js";
import { loadHarnessContext, type PatternKey } from "./harness-context.js";
import type { Agent, AgentInput, GeneratedFile } from "../types.js";

export interface CreateAgentOptions {
  repoRoot: string;
  llm: AnthropicClient;
  /** Override default model (sonnet-4-6). Use opus-4-7 for pedantic tickets. */
  model?: ClaudeModel;
  /** Max output tokens. Default 32000 — large enough for a 6-file connector tree with generous RUNBOOK. */
  maxTokens?: number;
}

export function createAgent(opts: CreateAgentOptions): Agent {
  const model = opts.model ?? DEFAULT_MODEL;
  // 8k sits under the Anthropic SDK's non-streaming safety guard
  // (>10min requests require streaming). The parser is lenient on
  // truncated trailing blocks, so if the full connector tree doesn't
  // fit, we still commit what did. A streaming-aware path would
  // remove the cap — future work per the agent integration doc.
  const maxTokens = opts.maxTokens ?? 8_000;

  return {
    async generateConnector(input: AgentInput): Promise<GeneratedFile[]> {
      const patternKey = pickPattern(input.ticket);
      const ctx = await loadHarnessContext({ repoRoot: opts.repoRoot, pattern: patternKey });

      const system = buildSystemPrompt(ctx);
      const user = buildUserPrompt(input);

      const response = await opts.llm.generate({
        model,
        maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      });

      const parsed = parseAgentOutput(response.text);
      if (!parsed.ok) {
        throw new Error(`agent: failed to parse LLM output — ${parsed.error}`);
      }

      return parsed.files;
    },
  };
}

function pickPattern(ticket: Record<string, unknown>): PatternKey {
  const source = ticket.user_model_source;
  if (source === "ldap") return "ldap";
  throw new Error(
    `agent: unknown user_model_source "${String(source)}" — supported patterns: ldap. ` +
      `Workday and custom-db patterns will be wired when their reference connectors land.`,
  );
}

function buildSystemPrompt(ctx: Awaited<ReturnType<typeof loadHarnessContext>>): string {
  const skeletonSection = ctx.skeletonFiles
    .map((f) => `### ${f.path}\n\n\`\`\`typescript\n${f.content}\n\`\`\``)
    .join("\n\n");

  const referenceSection = ctx.referenceFiles
    .map((f) => `### ${f.path}\n\n\`\`\`${f.path.endsWith(".md") ? "markdown" : "typescript"}\n${f.content}\n\`\`\``)
    .join("\n\n");

  return `You are the code-generating agent inside an Okta Professional Services orchestrator. Your task: given a Linear ticket that describes a customer's custom user-management API, generate a working SCIM 2.0 connector that bridges Okta (SCIM) to the customer's native API.

# Grounding

## Okta dialect — the quirks that gate OIN acceptance

${ctx.dialect}

## Pattern ${ctx.patternKey}

${ctx.pattern}

## SCIM skeleton (the harness — you COMPOSE with these, you don't reimplement them)

${skeletonSection}

## Reference connector (AcmeHR — the pattern you imitate)

${referenceSection}

# Your job

Generate the files that go under \`connectors/<customer-slug>/\` for the ticket's customer. At minimum:

1. \`connectors/<slug>/mapping.ts\` — pure SCIM↔native attribute transforms
2. \`connectors/<slug>/client.ts\` — HTTP client for the customer's native API
3. \`connectors/<slug>/store.ts\` — UserStore implementation wiring client + mapping
4. \`connectors/<slug>/server.ts\` — factory that composes skeleton.createApp
5. \`connectors/<slug>/start.ts\` — standalone entrypoint
6. \`connectors/<slug>/RUNBOOK.md\` — env vars, deploy, rollback, smoke, limitations, on-call (all 6 sections non-empty — Law 9 enforces this in pre-commit)

# Laws the generated connector MUST satisfy

Every Okta-specific code path MUST cite \`docs/okta-dialect.md\` or an RFC (Law 3 DIALECT-CITED). The pre-commit hook blocks commits without citations.

No real customer data, no real API tokens, no real user PII — all env vars, all placeholders. Law 4 SECRETS-OUT.

RUNBOOK.md MUST have all 6 sections populated. No TBD / placeholder. Law 9.

# Output format

Emit each file as a block in this exact structure. Emit blocks one after another — any narration BETWEEN blocks is fine, but you MUST use these EXACT delimiter strings:

---FILE: <repo-relative-path>
---MESSAGE: <conventional-commit-style message, e.g. "feat(bigcorp-hr): initial store">
---CONTENT---
<file content, any number of lines, any characters, no escaping needed>
---END---

Rules:
- Paths MUST be repo-relative. No leading slash. No \`..\` segments.
- Every block needs all four markers (FILE, MESSAGE, CONTENT, END).
- If you cannot generate a file, skip it — do NOT emit a partial block.

If the ticket is ambiguous, emit zero blocks and explain what you'd need.`;
}

function buildUserPrompt(input: AgentInput): string {
  const yaml = Object.entries(input.ticket)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `Ticket: ${input.ticketIdentifier}

\`\`\`yaml
${yaml}
\`\`\`

Generate the connector files.`;
}
