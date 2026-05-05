#!/usr/bin/env node
/**
 * Orchestrator daemon CLI.
 *
 * Wires real Linear + GitHub + Agent clients from env, runs runOnePoll
 * on a fixed interval. SIGINT / SIGTERM drain the current poll and exit
 * cleanly.
 *
 * Required env vars (see .env.example):
 *   LINEAR_API_KEY
 *   GITHUB_TOKEN
 *   ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL   (for the agent)
 *   ORCHESTRATOR_TEAM_KEY                   (Linear team key, e.g. "SCIM")
 *   ORCHESTRATOR_REPO_OWNER
 *   ORCHESTRATOR_REPO_NAME
 *   ORCHESTRATOR_BASE_BRANCH                (default "main")
 *   ORCHESTRATOR_INPROGRESS_STATE_ID        (Linear state uuid)
 *
 * Optional:
 *   ORCHESTRATOR_CANCELED_STATE_ID          (Linear state uuid — enables reject-to-cancel)
 *   ORCHESTRATOR_POLL_INTERVAL_MS           (default 30_000)
 *
 * Agent implementation: NOT YET BUILT. The orchestrator spawns a stub
 * agent that returns zero files by default; the accepted-flow still
 * opens a diagnostic PR. Real agent (prompt + harness context + SDK
 * call) lands in a follow-on commit.
 */
import { fromEnv as linearFromEnv } from "../linear/linear-client.js";
import { fromEnv as githubFromEnv } from "../github/github-client.js";
import { createLogger } from "../../skeleton/logger.js";
import { runOnePoll, type ProcessedHistory } from "./loop.js";
import { processTicket } from "./processor.js";
import type { Agent, GeneratedFile, OrchestratorRepoConfig } from "./types.js";

const log = createLogger({ base: { component: "orchestrator" } });

interface Config {
  teamKey: string;
  repo: OrchestratorRepoConfig;
  inProgressStateId: string;
  canceledStateId?: string;
  pollIntervalMs: number;
}

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value || value === "") {
    process.stderr.write(`orchestrator: ${name} is required (see .env.example)\n`);
    process.exit(4);
  }
  return value;
}

function readConfig(): Config {
  const config: Config = {
    teamKey: mustEnv("ORCHESTRATOR_TEAM_KEY"),
    repo: {
      owner: mustEnv("ORCHESTRATOR_REPO_OWNER"),
      repo: mustEnv("ORCHESTRATOR_REPO_NAME"),
      baseBranch: process.env.ORCHESTRATOR_BASE_BRANCH ?? "main",
    },
    inProgressStateId: mustEnv("ORCHESTRATOR_INPROGRESS_STATE_ID"),
    pollIntervalMs: Number.parseInt(process.env.ORCHESTRATOR_POLL_INTERVAL_MS ?? "30000", 10),
  };
  const canceled = process.env.ORCHESTRATOR_CANCELED_STATE_ID;
  if (canceled) config.canceledStateId = canceled;
  return config;
}

/**
 * Stub agent — returns zero files. The processor handles this by opening
 * a diagnostic PR ("Agent generated empty connector — operator review
 * required"). Replace with the real prompt-driven agent in a follow-on
 * commit.
 */
const STUB_AGENT: Agent = {
  async generateConnector(): Promise<GeneratedFile[]> {
    return [];
  },
};

async function main(): Promise<void> {
  const config = readConfig();
  const linear = linearFromEnv();
  const github = githubFromEnv();
  const history = new Map<string, ProcessedHistory>();

  log.info("orchestrator_starting", { ...config });

  let shuttingDown = false;
  const stop = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("orchestrator_stopping", { signal });
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  while (!shuttingDown) {
    const started = Date.now();
    const report = await runOnePoll({
      linear,
      teamKey: config.teamKey,
      process: (issue) => processTicket({
        issue,
        linear,
        github,
        agent: STUB_AGENT,
        repo: config.repo,
        inProgressStateId: config.inProgressStateId,
        ...(config.canceledStateId !== undefined && { canceledStateId: config.canceledStateId }),
      }),
      history,
    });
    const durationMs = Date.now() - started;

    if (report.listError) {
      log.warn("poll_list_failed", { error: report.listError, durationMs });
    } else if (report.processed === 0 && report.skipped === 0) {
      log.debug("poll_empty", { durationMs });
    } else {
      log.info("poll_complete", { ...report, durationMs });
    }

    if (shuttingDown) break;
    await sleep(config.pollIntervalMs);
  }

  log.info("orchestrator_stopped");
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  log.error("orchestrator_fatal", { error: message });
  process.exit(5);
});
