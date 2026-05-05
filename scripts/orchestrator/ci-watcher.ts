/**
 * CI watcher — polls GitHub check runs on a ref until all reach a
 * terminal state, returns aggregated verdict.
 *
 * Orchestrator integration (post-processTicket): when a PR opens, the
 * orchestrator spawns waitForChecks against the PR's head SHA. On
 * passed → trigger runSmoke + buildManifest + signManifest. On failed
 * → comment the Linear ticket with which checks failed. On timeout or
 * error → comment + leave the ticket in In Progress for manual review.
 *
 * Conclusion mapping:
 *   success, neutral, skipped    → treated as pass
 *   failure, cancelled, timed_out, action_required, stale → treated as fail
 *   null (still running)          → keep polling
 *
 * Retry policy: transient getCheckRuns errors (5xx, network) are
 * retried up to 3 times consecutively. After 3 in a row → status=error.
 *
 * Timers are injected via `sleep` so tests don't wait for real time.
 */
import type { GitHubClient } from "../github/github-client.js";
import type { CheckRun } from "../github/types.js";

export interface WaitForChecksOptions {
  github: GitHubClient;
  owner: string;
  repo: string;
  ref: string;
  /** Max number of poll iterations before giving up. Default 60 (30 min at default interval). */
  maxPolls?: number;
  /** Wait between polls. Default 30_000. */
  pollIntervalMs?: number;
  /** Inject for tests — bypasses real setTimeout. Default real sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface CheckWatchResult {
  status: "passed" | "failed" | "timeout" | "no_checks" | "error";
  runs: CheckRun[];
  error?: string;
}

const PASS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAIL_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "stale"]);

export async function waitForChecks(opts: WaitForChecksOptions): Promise<CheckWatchResult> {
  const maxPolls = opts.maxPolls ?? 60;
  const pollIntervalMs = opts.pollIntervalMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;

  let consecutiveErrors = 0;
  let lastError: string | undefined;
  let lastRuns: CheckRun[] = [];

  for (let i = 0; i < maxPolls; i++) {
    let runs: CheckRun[];
    try {
      runs = await opts.github.getCheckRuns({ owner: opts.owner, repo: opts.repo, ref: opts.ref });
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      lastError = err instanceof Error ? err.message : String(err);
      if (consecutiveErrors >= 3) {
        return { status: "error", runs: lastRuns, error: lastError };
      }
      await sleep(pollIntervalMs);
      continue;
    }

    lastRuns = runs;

    if (runs.length === 0) {
      // No checks yet. GitHub may not have registered workflows. Keep
      // polling for a few ticks, then give up with a distinct signal.
      if (i >= 2) return { status: "no_checks", runs };
      await sleep(pollIntervalMs);
      continue;
    }

    const allTerminal = runs.every((r) => r.status === "completed");
    if (allTerminal) {
      const anyFailed = runs.some((r) => r.conclusion !== null && FAIL_CONCLUSIONS.has(r.conclusion));
      if (anyFailed) return { status: "failed", runs };
      const allPassed = runs.every((r) => r.conclusion !== null && PASS_CONCLUSIONS.has(r.conclusion));
      if (allPassed) return { status: "passed", runs };
      // Mixed / unexpected conclusion values — fail conservative.
      return { status: "failed", runs };
    }

    await sleep(pollIntervalMs);
  }

  return { status: "timeout", runs: lastRuns };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
