/**
 * Thin wrapper around @anthropic-ai/sdk pinned to Okta's LiteLLM proxy.
 *
 * Why this layer:
 *   - Normalizes the SDK's shape into orchestrator-friendly types
 *     (scripts/llm/types.ts). Callers never import from @anthropic-ai/sdk
 *     directly, so a future provider swap is a one-file edit.
 *   - Fails fast on missing env vars (no mystery 401s at LLM call time).
 *   - Redacts the api key out of any SDK error message before rethrow.
 *     The SDK occasionally bakes request headers into its error strings;
 *     logging those unredacted would leak the key.
 *   - Enforces input sanity (empty messages, non-positive maxTokens).
 *
 * See docs/integrations/anthropic-sdk.md for the endpoint + auth scheme
 * this wraps. Live-probed 2026-05-05 against claude-sonnet-4-6.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_MODEL,
  LlmClientError,
  type GenerateRequest,
  type GenerateResponse,
} from "./types.js";

/**
 * Duck-typed slice of @anthropic-ai/sdk that we actually call. Lets tests
 * inject a fake without subclassing the real Anthropic class.
 */
export interface SdkLike {
  messages: {
    create(req: unknown): Promise<SdkMessageResponse>;
  };
}

interface SdkMessageResponse {
  id: string;
  type: string;
  role: string;
  model: string;
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface AnthropicClientOptions {
  apiKey: string;
  baseUrl: string;
  /** Inject for tests; defaults to a real Anthropic SDK instance. */
  sdk?: SdkLike;
}

export interface AnthropicClient {
  generate(req: GenerateRequest): Promise<GenerateResponse>;
}

export function createAnthropicClient(options: AnthropicClientOptions): AnthropicClient {
  if (!options.apiKey) {
    throw new Error("createAnthropicClient: apiKey is required (got empty string)");
  }
  if (!options.baseUrl) {
    throw new Error("createAnthropicClient: baseUrl is required (got empty string)");
  }

  // The @anthropic-ai/sdk already prepends "/v1/messages" to requests, so
  // baseURL must NOT include "/v1" or every request hits "/v1/v1/messages"
  // and 404s. Our .env convention + integration doc use a `/v1`-suffixed
  // URL (for curl ergonomics) — strip the trailing /v1 defensively here so
  // callers don't need to remember this quirk. TRUTH LAW: behavior tested
  // in anthropic-client.test.ts; live-probed 2026-05-05.
  const sdkBaseUrl = options.baseUrl.replace(/\/v1\/?$/, "");

  const sdk: SdkLike = options.sdk ?? new Anthropic({
    apiKey: options.apiKey,
    baseURL: sdkBaseUrl,
  });

  const apiKey = options.apiKey;

  return {
    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      if (!req.messages || req.messages.length === 0) {
        throw new LlmClientError(undefined, "generate: messages is empty — at least one message required");
      }
      if (req.maxTokens <= 0) {
        throw new LlmClientError(undefined, `generate: maxTokens must be > 0 (got ${req.maxTokens})`);
      }

      const model = req.model ?? DEFAULT_MODEL;

      let raw: SdkMessageResponse;
      try {
        raw = await sdk.messages.create({
          model,
          max_tokens: req.maxTokens,
          ...(req.system !== undefined && { system: req.system }),
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        });
      } catch (err) {
        throw wrapSdkError(err, apiKey);
      }

      const text = raw.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("");

      return {
        model: raw.model,
        text,
        stopReason: raw.stop_reason ?? "end_turn",
        inputTokens: raw.usage.input_tokens,
        outputTokens: raw.usage.output_tokens,
      };
    },
  };
}

/**
 * Convenience constructor that reads ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL
 * from process.env. Optional sdk injection for tests.
 */
export function fromEnv(opts: { sdk?: SdkLike } = {}): AnthropicClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "fromEnv: ANTHROPIC_API_KEY is not set — add it to .env (see .env.example)",
    );
  }
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1";
  return createAnthropicClient({
    apiKey,
    baseUrl,
    ...(opts.sdk !== undefined && { sdk: opts.sdk }),
  });
}

function wrapSdkError(err: unknown, apiKey: string): LlmClientError {
  const status = extractStatus(err);
  const rawMessage = err instanceof Error ? err.message : String(err);
  // Redact the api key if the SDK baked it into its error text.
  const safeMessage = apiKey ? rawMessage.split(apiKey).join("[REDACTED]") : rawMessage;
  return new LlmClientError(status, `anthropic SDK error: ${safeMessage}`);
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}
