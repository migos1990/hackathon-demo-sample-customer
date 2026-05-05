/**
 * Orchestrator polling loop.
 *
 * runOnePoll() is the atomic unit. The long-running daemon is built by
 * calling runOnePoll in a setInterval (scripts/orchestrator/cli.ts).
 * Tests call runOnePoll directly — no timers in test code.
 *
 * Dedup policy (history Map):
 *   - accepted      → terminal dedup. Next polls skip the ticket.
 *   - rejected      → terminal dedup. Rejection is the operator's
 *                     signal to fix the ticket; they reopen it, which
 *                     creates a NEW issue id → fresh history slot.
 *   - failed        → NOT deduped. Retry on every subsequent poll
 *                     until accept/reject/manual-intervention.
 *
 * Error isolation:
 *   - Per-ticket exceptions from process() are caught and counted as
 *     "failed"; the poll continues through remaining tickets.
 *   - list failures (Linear API down) abort the poll cleanly with a
 *     listError on the report. Daemon loop retries on next interval.
 */
import type { LinearClient } from "../linear/linear-client.js";
import type { LinearIssue } from "../linear/types.js";
import type { TicketProcessingResult } from "./types.js";

export interface ProcessedHistory {
  lastStatus: "accepted" | "rejected" | "failed";
  at: string;
}

export interface PollOptions {
  linear: LinearClient;
  teamKey: string;
  /** Per-ticket processor. Injected so tests can substitute fakes; production wires to processTicket. */
  process: (issue: LinearIssue) => Promise<TicketProcessingResult>;
  /** Cross-poll dedup state. Caller owns this — allows restart-safe extensions later. */
  history: Map<string, ProcessedHistory>;
  /** Filter tickets by state types. Defaults to triage + unstarted. */
  stateTypes?: Array<"triage" | "unstarted" | "started" | "completed" | "canceled" | string>;
}

export interface PollReport {
  processed: number;
  accepted: number;
  rejected: number;
  failed: number;
  skipped: number;
  listError?: string;
}

export async function runOnePoll(opts: PollOptions): Promise<PollReport> {
  const report: PollReport = {
    processed: 0, accepted: 0, rejected: 0, failed: 0, skipped: 0,
  };

  let issues: LinearIssue[];
  try {
    issues = await opts.linear.listIssuesByTeam({
      teamKey: opts.teamKey,
      ...(opts.stateTypes !== undefined && { stateTypes: opts.stateTypes }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.listError = message;
    return report;
  }

  for (const issue of issues) {
    const prior = opts.history.get(issue.identifier);
    if (prior && prior.lastStatus !== "failed") {
      // accepted + rejected are terminal for dedup
      report.skipped++;
      continue;
    }

    let result: TicketProcessingResult;
    try {
      result = await opts.process(issue);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = { status: "failed", reason: message };
    }

    report.processed++;
    if (result.status === "accepted") report.accepted++;
    else if (result.status === "rejected") report.rejected++;
    else report.failed++;

    opts.history.set(issue.identifier, {
      lastStatus: result.status,
      at: new Date().toISOString(),
    });
  }

  return report;
}
