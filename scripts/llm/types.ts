/**
 * LLM-client types — orchestrator's own shapes so we don't leak
 * @anthropic-ai/sdk internals across every caller. Keeps the swap
 * surface small if we ever need to move off LiteLLM.
 */

export type ClaudeModel =
  | "claude-sonnet-4-6"
  | "claude-sonnet-4-5"
  | "claude-opus-4-7"
  | "claude-opus-4-6"
  | "claude-opus-4-5"
  | "claude-haiku-4-5";

/** Default for orchestrator generation. See docs/integrations/anthropic-sdk.md. */
export const DEFAULT_MODEL: ClaudeModel = "claude-sonnet-4-6";

/** For architecture-review delegations the agent makes. */
export const REASONING_MODEL: ClaudeModel = "claude-opus-4-7";

/** For trivial classification (ticket routing, schema validation). */
export const FAST_MODEL: ClaudeModel = "claude-haiku-4-5";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  model?: ClaudeModel;
  maxTokens: number;
  system?: string;
  messages: ChatMessage[];
}

export interface GenerateResponse {
  model: string;
  text: string;
  stopReason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal" | string;
  inputTokens: number;
  outputTokens: number;
}

export class LlmClientError extends Error {
  constructor(public readonly status: number | undefined, message: string) {
    super(message);
    this.name = "LlmClientError";
  }
}
