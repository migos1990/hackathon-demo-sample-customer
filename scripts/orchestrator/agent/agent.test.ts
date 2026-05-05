/**
 * Agent tests — verify the agent loads context, builds a prompt, calls
 * the LLM, and parses the response into GeneratedFile[].
 *
 * Injects a fake AnthropicClient so no live LLM call. Integration via
 * scripts/orchestrator/agent/live-probe.ts (gated on ANTHROPIC_API_KEY).
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { createAgent } from "./agent.js";
import type { AnthropicClient } from "../../llm/anthropic-client.js";
import type { GenerateRequest, GenerateResponse } from "../../llm/types.js";
import type { AgentInput } from "../types.js";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function fakeLlm(response: string | ((req: GenerateRequest) => string)): AnthropicClient {
  return {
    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      const text = typeof response === "function" ? response(req) : response;
      return { model: "fake", text, stopReason: "end_turn", inputTokens: 10, outputTokens: 5 };
    },
  };
}

const VALID_TICKET: Record<string, unknown> = {
  customer_app_name: "BigCorpHR",
  customer_slug: "bigcorp-hr",
  user_model_source: "ldap",
  base_url: "https://api.bigcorp-hr.example.com",
  auth_method: "bearer",
};

const AGENT_INPUT: AgentInput = { ticket: VALID_TICKET, ticketIdentifier: "SCIM-1" };

describe("createAgent — happy path", () => {
  it("parses the LLM response into GeneratedFile[]", async () => {
    const llmResponse = `---FILE: connectors/bigcorp-hr/store.ts
---MESSAGE: feat: BigCorpHR store
---CONTENT---
export class BigCorpStore {}
---END---`;
    const agent = createAgent({ repoRoot: REPO_ROOT, llm: fakeLlm(llmResponse) });
    const files = await agent.generateConnector(AGENT_INPUT);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("connectors/bigcorp-hr/store.ts");
  });

  it("passes the customer_slug into the prompt so the LLM knows the target directory", async () => {
    let observedPrompt = "";
    const agent = createAgent({
      repoRoot: REPO_ROOT,
      llm: fakeLlm((req) => {
        observedPrompt = req.messages.map((m) => m.content).join("\n");
        return "";
      }),
    });
    await agent.generateConnector(AGENT_INPUT);
    expect(observedPrompt).toContain("bigcorp-hr");
  });

  it("includes harness context (dialect + pattern + skeleton + reference) in the prompt", async () => {
    let systemObserved = "";
    const agent = createAgent({
      repoRoot: REPO_ROOT,
      llm: fakeLlm((req) => {
        systemObserved = req.system ?? "";
        return "";
      }),
    });
    await agent.generateConnector(AGENT_INPUT);
    // Dialect markers
    expect(systemObserved).toMatch(/PATCH|active|okta-dialect/i);
    // Pattern markers
    expect(systemObserved).toMatch(/uid|cn|memberOf/);
    // Skeleton markers
    expect(systemObserved).toMatch(/UserStore|ScimUser/);
    // Reference (connectors/acme-hr)
    expect(systemObserved).toMatch(/acme-hr/);
  });

  it("selects the pattern based on ticket.user_model_source", async () => {
    let systemObserved = "";
    const agent = createAgent({
      repoRoot: REPO_ROOT,
      llm: fakeLlm((req) => {
        systemObserved = req.system ?? "";
        return "";
      }),
    });
    await agent.generateConnector(AGENT_INPUT);
    // LDAP pattern should be loaded — should see the Pattern 1 doc markers
    expect(systemObserved).toMatch(/Pattern 1|LDAP-shaped/);
  });

  it("uses sonnet-4-6 by default, allows opus override", async () => {
    let observedModel = "";
    const agent = createAgent({
      repoRoot: REPO_ROOT,
      llm: fakeLlm((req) => {
        observedModel = req.model ?? "default";
        return "";
      }),
    });
    await agent.generateConnector(AGENT_INPUT);
    expect(observedModel).toBe("claude-sonnet-4-6");

    const opusAgent = createAgent({
      repoRoot: REPO_ROOT,
      llm: fakeLlm((req) => {
        observedModel = req.model ?? "default";
        return "";
      }),
      model: "claude-opus-4-7",
    });
    await opusAgent.generateConnector(AGENT_INPUT);
    expect(observedModel).toBe("claude-opus-4-7");
  });
});

describe("createAgent — error surfaces", () => {
  it("throws when the LLM output fails to parse", async () => {
    const badOutput = "---FILE: x.ts\n---CONTENT---\nbody\n---END---"; // missing MESSAGE
    const agent = createAgent({ repoRoot: REPO_ROOT, llm: fakeLlm(badOutput) });
    await expect(agent.generateConnector(AGENT_INPUT)).rejects.toThrow(/MESSAGE|parse/i);
  });

  it("rejects a path-traversal attempt in the LLM output", async () => {
    const evilOutput = `---FILE: ../../../etc/passwd
---MESSAGE: m
---CONTENT---
oops
---END---`;
    const agent = createAgent({ repoRoot: REPO_ROOT, llm: fakeLlm(evilOutput) });
    await expect(agent.generateConnector(AGENT_INPUT)).rejects.toThrow(/path|traversal/);
  });

  it("returns empty [] when the LLM emits no file blocks (explicit non-generation)", async () => {
    const agent = createAgent({
      repoRoot: REPO_ROOT,
      llm: fakeLlm("I don't have enough information to generate. Clarify ticket first."),
    });
    const files = await agent.generateConnector(AGENT_INPUT);
    expect(files).toEqual([]);
  });

  it("rejects an unsupported user_model_source (Workday/custom-db pattern not yet filled)", async () => {
    const agent = createAgent({ repoRoot: REPO_ROOT, llm: fakeLlm("") });
    await expect(
      agent.generateConnector({
        ticket: { ...VALID_TICKET, user_model_source: "workday" },
        ticketIdentifier: "SCIM-X",
      }),
    ).rejects.toThrow(/pattern|workday|unknown/i);
  });
});
