/**
 * Per-ticket processor — the core orchestrator state machine.
 *
 * Flow per ticket:
 *   1. Extract YAML front-matter from ticket.description
 *   2. Validate against ticket-templates/schema.json
 *   3. If invalid: comment + cancel. Return rejected.
 *   4. Call agent.generateConnector() with validated ticket
 *   5. Create branch off baseBranch
 *   6. Write each generated file to the branch (one commit per file)
 *   7. Open PR
 *   8. Comment Linear with PR link, advance state to "in progress"
 *   9. Return accepted
 *
 * Failure during steps 4-8 returns status=failed and intentionally does
 * NOT advance state — the next poll retries the ticket. Only validation
 * failures (steps 1-3) move the ticket to canceled; the agent gets
 * retried on transient errors.
 *
 * TRUTH LAW: atomicity claim — "state advances only on accept; retries
 * don't dup-open PRs" is tested via processor.test.ts. A future poll
 * dedup (based on "has this ticket already been commented with a PR
 * link?") would harden against the failed-after-branch-created case.
 * Not yet built — single-commit scope.
 */
import { randomBytes } from "node:crypto";
import type { GitHubClient } from "../github/github-client.js";
import type { LinearClient } from "../linear/linear-client.js";
import type { LinearIssue } from "../linear/types.js";
import { validateTicket } from "../validators/ticket-validator.js";
import { extractFrontMatter } from "./front-matter.js";
import type {
  Agent,
  GeneratedFile,
  OrchestratorRepoConfig,
  RejectionReason,
  TicketProcessingResult,
} from "./types.js";

export interface ProcessTicketOptions {
  issue: LinearIssue;
  linear: LinearClient;
  github: GitHubClient;
  agent: Agent;
  repo: OrchestratorRepoConfig;
  /** Linear state id to move the ticket to on accept. */
  inProgressStateId: string;
  /** Linear state id to move the ticket to on rejection. Optional — omit to leave ticket in its current state. */
  canceledStateId?: string;
}

export async function processTicket(opts: ProcessTicketOptions): Promise<TicketProcessingResult> {
  const description = opts.issue.description ?? "";

  // Steps 1-2: extract + validate.
  const extracted = extractFrontMatter(description);
  if (!extracted.ok) {
    await rejectTicket(opts, extracted.reason, [extracted.detail]);
    return { status: "rejected", reason: extracted.reason, errors: [extracted.detail] };
  }

  const validation = validateTicket(extracted.data);
  if (!validation.ok) {
    const errors = validation.errors.map((e) => e.message);
    await rejectTicket(opts, "schema-violation", errors);
    return { status: "rejected", reason: "schema-violation", errors };
  }

  // Steps 3-8: generate + PR. Anything from here on that throws returns
  // failed (and DOES NOT advance state), so the next poll retries.
  try {
    return await runAcceptedFlow(opts, extracted.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await opts.linear.commentOnIssue({
      issueId: opts.issue.id,
      body: `⚠️ Orchestrator failure (will retry on next poll): ${safeTrim(message, 500)}`,
    }).catch(() => { /* best effort */ });
    return { status: "failed", reason: message };
  }
}

async function runAcceptedFlow(
  opts: ProcessTicketOptions,
  ticket: Record<string, unknown>,
): Promise<TicketProcessingResult> {
  const customerSlug = typeof ticket.customer_slug === "string" ? ticket.customer_slug : "unknown";
  const branch = branchNameFor(opts.issue.identifier, customerSlug);

  // Step 3: generate files via the agent. Errors here retry-safe (no
  // GitHub state yet).
  const files: GeneratedFile[] = await opts.agent.generateConnector({
    ticket,
    ticketIdentifier: opts.issue.identifier,
  });

  // Step 4: create branch.
  await opts.github.createBranch({
    owner: opts.repo.owner,
    repo: opts.repo.repo,
    fromBranch: opts.repo.baseBranch,
    newBranch: branch,
  });

  // Step 5: write each file (one commit per file — PR history stays
  // readable even when the agent generates ~15 files).
  for (const file of files) {
    await opts.github.writeFile({
      owner: opts.repo.owner,
      repo: opts.repo.repo,
      branch,
      path: file.path,
      content: file.content,
      message: file.message,
    });
  }

  // Step 6: open PR.
  const prTitle = files.length === 0
    ? `[${opts.issue.identifier}] Agent generated empty connector — operator review required`
    : `[${opts.issue.identifier}] ${opts.issue.title}`;
  const prBody = prBodyFor(opts.issue, ticket, files);
  const pr = await opts.github.openPr({
    owner: opts.repo.owner,
    repo: opts.repo.repo,
    head: branch,
    base: opts.repo.baseBranch,
    title: prTitle,
    body: prBody,
  });

  // Step 7: comment Linear with PR link.
  await opts.linear.commentOnIssue({
    issueId: opts.issue.id,
    body: [
      `Orchestrator: generated connector for **${customerSlug}**, opened PR.`,
      "",
      `- Branch: \`${branch}\``,
      `- PR: ${pr.url}`,
      `- Files written: ${files.length}`,
      "",
      "CI runs now. On green → signed Promotion Manifest + pre-prod deploy.",
    ].join("\n"),
  });

  // Step 8: advance state.
  await opts.linear.updateIssueState({
    issueId: opts.issue.id,
    stateId: opts.inProgressStateId,
  });

  return {
    status: "accepted",
    prNumber: pr.number,
    prUrl: pr.url,
    branch,
    filesWritten: files.length,
  };
}

async function rejectTicket(
  opts: ProcessTicketOptions,
  reason: RejectionReason,
  errors: string[],
): Promise<void> {
  const body = [
    `❌ Orchestrator: **schema violation**. Ticket cannot be dispatched.`,
    "",
    `Reason: \`${reason}\``,
    "",
    "Errors:",
    ...errors.map((e) => `- ${e}`),
    "",
    "Fix the ticket front-matter and re-open. See `ticket-templates/new-scim-connector.md` for the contract.",
  ].join("\n");

  await opts.linear.commentOnIssue({
    issueId: opts.issue.id,
    body,
  });

  if (opts.canceledStateId) {
    await opts.linear.updateIssueState({
      issueId: opts.issue.id,
      stateId: opts.canceledStateId,
    });
  }
}

/**
 * Branch name: `agent/<team-key>-<customer-slug>-<random-suffix>`. Random
 * suffix prevents re-processing the same ticket (on a retry after a
 * runtime failure) from colliding with a half-created branch.
 */
function branchNameFor(ticketIdentifier: string, customerSlug: string): string {
  const key = ticketIdentifier.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const suffix = randomBytes(3).toString("hex");
  return `agent/${key}-${customerSlug}-${suffix}`;
}

function prBodyFor(issue: LinearIssue, ticket: Record<string, unknown>, files: GeneratedFile[]): string {
  const lines = [
    `**Generated by orchestrator from ${issue.identifier}.**`,
    "",
    `- Ticket: ${issue.url}`,
    `- Customer: \`${String(ticket.customer_slug ?? "unknown")}\``,
    `- Target: \`${String(ticket.target_okta_tenant ?? "unknown")}\``,
    `- Terraform workspace: \`${String(ticket.terraform_workspace ?? "unknown")}\``,
    `- Files: ${files.length}`,
    "",
    "## What happens next",
    "",
    "1. CI runs the full harness gate (14 meta-laws + 10 connector laws).",
    "2. If green, pre-prod Terraform applies this connector to the staging tenant.",
    "3. Pre-prod verify gate runs (tsc, vitest, OIN SPEC, smoke).",
    "4. On all-green, a signed Promotion Manifest is generated and awaits human promote.",
    "",
    "Do NOT merge this PR manually. The orchestrator drives promotion via the signed-manifest flow.",
  ];
  if (files.length === 0) {
    lines.splice(5, 0, "", "⚠️ Agent returned ZERO files. Operator review required — this PR is a placeholder for diagnosis.");
  }
  return lines.join("\n");
}

function safeTrim(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
