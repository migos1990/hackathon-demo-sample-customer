/**
 * CI watcher tests — polls getCheckRuns until all checks reach a terminal
 * state, returns aggregated pass/fail/timeout verdict.
 *
 * Tests use a controllable fake GitHub client whose getCheckRuns() returns
 * whatever the current tick of the fake clock dictates. No real timers;
 * inject a fake sleep so tests complete in milliseconds.
 */
import { describe, it, expect } from "vitest";
import { waitForChecks } from "./ci-watcher.js";
import type { GitHubClient } from "../github/github-client.js";
import type { CheckRun } from "../github/types.js";

function githubWithChecks(ticks: CheckRun[][]): GitHubClient {
  let tick = 0;
  return {
    async createBranch() { /* unused */ },
    async writeFile() { /* unused */ },
    async openPr() { return { number: 1, url: "u", nodeId: "PR_1" }; },
    async getCheckRuns() {
      const runs = ticks[Math.min(tick, ticks.length - 1)] ?? [];
      tick++;
      return runs;
    },
    async commentOnPr() { /* unused */ },
  };
}

const REPO = { owner: "x", repo: "y" };

describe("waitForChecks — happy paths", () => {
  it("returns passed when all runs are completed with conclusion=success", async () => {
    const github = githubWithChecks([
      [{ name: "vitest", status: "completed", conclusion: "success", detailsUrl: null }],
    ]);
    const result = await waitForChecks({
      github, ref: "sha-x", ...REPO,
      sleep: async () => { /* instant */ },
    });
    expect(result.status).toBe("passed");
    expect(result.runs).toHaveLength(1);
  });

  it("polls through queued → in_progress → completed transitions", async () => {
    const github = githubWithChecks([
      [{ name: "vitest", status: "queued", conclusion: null, detailsUrl: null }],
      [{ name: "vitest", status: "in_progress", conclusion: null, detailsUrl: null }],
      [{ name: "vitest", status: "completed", conclusion: "success", detailsUrl: null }],
    ]);
    const result = await waitForChecks({
      github, ref: "sha-x", ...REPO,
      sleep: async () => { /* instant */ },
    });
    expect(result.status).toBe("passed");
  });

  it("returns failed when any single run conclusion != success", async () => {
    const github = githubWithChecks([[
      { name: "vitest", status: "completed", conclusion: "success", detailsUrl: null },
      { name: "tsc", status: "completed", conclusion: "failure", detailsUrl: "https://x/runs/tsc" },
    ]]);
    const result = await waitForChecks({
      github, ref: "sha-x", ...REPO,
      sleep: async () => { /* instant */ },
    });
    expect(result.status).toBe("failed");
    const failedRuns = result.runs.filter((r) => r.conclusion === "failure");
    expect(failedRuns).toHaveLength(1);
    expect(failedRuns[0]?.name).toBe("tsc");
  });

  it("treats cancelled / timed_out / action_required as failures", async () => {
    const github = githubWithChecks([[
      { name: "a", status: "completed", conclusion: "cancelled", detailsUrl: null },
    ]]);
    const result = await waitForChecks({
      github, ref: "sha-x", ...REPO,
      sleep: async () => { /* instant */ },
    });
    expect(result.status).toBe("failed");
  });

  it("treats neutral + skipped as passing (GitHub conventions)", async () => {
    const github = githubWithChecks([[
      { name: "a", status: "completed", conclusion: "success", detailsUrl: null },
      { name: "b", status: "completed", conclusion: "neutral", detailsUrl: null },
      { name: "c", status: "completed", conclusion: "skipped", detailsUrl: null },
    ]]);
    const result = await waitForChecks({
      github, ref: "sha-x", ...REPO,
      sleep: async () => { /* instant */ },
    });
    expect(result.status).toBe("passed");
  });
});

describe("waitForChecks — zero-checks handling", () => {
  it("treats zero check runs as 'no_checks' (can't say passed, can't say failed)", async () => {
    const github = githubWithChecks([[]]);
    const result = await waitForChecks({
      github, ref: "sha-x", ...REPO,
      sleep: async () => { /* instant */ },
      maxPolls: 3,
    });
    expect(result.status).toBe("no_checks");
  });
});

describe("waitForChecks — timeout", () => {
  it("returns timeout when maxPolls exceeded before all runs complete", async () => {
    const github = githubWithChecks([
      [{ name: "vitest", status: "in_progress", conclusion: null, detailsUrl: null }],
    ]);
    const result = await waitForChecks({
      github, ref: "sha-x", ...REPO,
      sleep: async () => { /* instant */ },
      maxPolls: 3,
    });
    expect(result.status).toBe("timeout");
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.status).toBe("in_progress");
  });

  it("sleeps pollIntervalMs between polls (verified via sleep fake capture)", async () => {
    const sleepDurations: number[] = [];
    const github = githubWithChecks([
      [{ name: "vitest", status: "in_progress", conclusion: null, detailsUrl: null }],
      [{ name: "vitest", status: "completed", conclusion: "success", detailsUrl: null }],
    ]);
    await waitForChecks({
      github, ref: "sha-x", ...REPO,
      sleep: async (ms: number) => { sleepDurations.push(ms); },
      pollIntervalMs: 5000,
      maxPolls: 10,
    });
    expect(sleepDurations).toContain(5000);
  });
});

describe("waitForChecks — error resilience", () => {
  it("retries on transient getCheckRuns failures up to 3 times", async () => {
    let callCount = 0;
    const github: GitHubClient = {
      async createBranch() { /* unused */ },
      async writeFile() { /* unused */ },
      async openPr() { return { number: 1, url: "u", nodeId: "PR_1" }; },
      async getCheckRuns() {
        callCount++;
        if (callCount <= 2) throw new Error("github: 502 bad gateway");
        return [{ name: "vitest", status: "completed", conclusion: "success", detailsUrl: null }];
      },
      async commentOnPr() { /* unused */ },
    };
    const result = await waitForChecks({
      github, ref: "sha-x", ...REPO,
      sleep: async () => { /* instant */ },
    });
    expect(result.status).toBe("passed");
    expect(callCount).toBe(3);
  });

  it("gives up after 3 consecutive transient failures (returns status=error)", async () => {
    const github: GitHubClient = {
      async createBranch() { /* unused */ },
      async writeFile() { /* unused */ },
      async openPr() { return { number: 1, url: "u", nodeId: "PR_1" }; },
      async getCheckRuns() { throw new Error("github: 500 persistent"); },
      async commentOnPr() { /* unused */ },
    };
    const result = await waitForChecks({
      github, ref: "sha-x", ...REPO,
      sleep: async () => { /* instant */ },
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/500|persistent/);
  });
});
