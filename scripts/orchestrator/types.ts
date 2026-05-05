/**
 * Orchestrator types — the glue between Linear tickets, the agent, and
 * the GitHub PR pipeline.
 *
 * Scoped to per-ticket processing plus the top-level loop envelope. The
 * polling loop (loop.ts) and CLI (cli.ts) compose these. Fakes live in
 * scripts/orchestrator/processor.test.ts for unit coverage; live
 * integration via scripts/orchestrator/live-probe.ts gated on all four
 * env vars being set (Linear + GitHub + Anthropic + base repo config).
 */

export interface GeneratedFile {
  /** Repo-relative path (e.g. "connectors/acme-hr/store.ts"). */
  path: string;
  content: string;
  /** Per-file commit message. Orchestrator writes one file per commit to keep the PR history readable. */
  message: string;
}

/**
 * Agent abstraction — takes a validated ticket + harness context, returns
 * the files to land in a new connector directory. Implementation is a
 * prompt + LLM call; tests substitute a fake that returns canned files.
 */
export interface Agent {
  generateConnector(input: AgentInput): Promise<GeneratedFile[]>;
}

export interface AgentInput {
  /** Full ticket YAML front-matter, already validated. */
  ticket: Record<string, unknown>;
  /** Ticket identifier (e.g. "SCIM-42") for traceability in prompts + logs. */
  ticketIdentifier: string;
}

/**
 * Per-ticket processing outcome. The orchestrator logs + acts on these:
 *   accepted  → happy path, PR opened, awaiting CI + smoke
 *   rejected  → validation failed, ticket commented, state moved to canceled
 *   failed    → runtime error mid-flow (GitHub API down, agent errored);
 *               left in current state for retry on next poll
 */
export type TicketProcessingResult =
  | { status: "accepted"; prNumber: number; prUrl: string; branch: string; filesWritten: number }
  | { status: "rejected"; reason: RejectionReason; errors: string[] }
  | { status: "failed"; reason: string };

export type RejectionReason =
  | "no-yaml-frontmatter"
  | "yaml-parse-error"
  | "schema-violation";

export interface OrchestratorRepoConfig {
  owner: string;
  repo: string;
  /** Default branch to fork connector branches from (usually "main"). */
  baseBranch: string;
}
