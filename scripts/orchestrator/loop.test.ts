/**
 * Polling-loop tests. Uses a controllable fake Linear that returns
 * issues in sequence + a fake processor that records invocations.
 * No timers — tests call poll() directly rather than relying on setInterval.
 */
import { describe, it, expect } from "vitest";
import { runOnePoll, type PollOptions, type ProcessedHistory } from "./loop.js";
import type { LinearClient } from "../linear/linear-client.js";
import type { LinearIssue } from "../linear/types.js";
import type { TicketProcessingResult } from "./types.js";

function issue(id: string, identifier: string, description = "body"): LinearIssue {
  return {
    id, identifier,
    title: `[${identifier}] test`,
    description,
    state: { id: "state-triage", name: "Triage", type: "triage" },
    team: { id: "team-1", key: "SCIM" },
    url: `https://linear.app/x/issue/${identifier}`,
    updatedAt: "2026-05-05T14:00:00Z",
  };
}

function fakeLinear(issues: LinearIssue[]): LinearClient {
  return {
    async listIssuesByTeam() { return issues; },
    async getIssue() { return null; },
    async commentOnIssue() { /* noop */ },
    async updateIssueState() { /* noop */ },
  };
}

describe("runOnePoll — basic", () => {
  it("processes each returned issue exactly once per poll", async () => {
    const seen: string[] = [];
    const history = new Map<string, ProcessedHistory>();
    const linear = fakeLinear([
      issue("u1", "SCIM-1"),
      issue("u2", "SCIM-2"),
      issue("u3", "SCIM-3"),
    ]);

    const process = async (iss: LinearIssue): Promise<TicketProcessingResult> => {
      seen.push(iss.identifier);
      return { status: "rejected", reason: "no-yaml-frontmatter", errors: ["no fence"] };
    };

    const opts: PollOptions = {
      linear,
      teamKey: "SCIM",
      process,
      history,
    };
    await runOnePoll(opts);
    expect(seen).toEqual(["SCIM-1", "SCIM-2", "SCIM-3"]);
  });

  it("skips tickets already processed (idempotent across polls)", async () => {
    const seen: string[] = [];
    const history = new Map<string, ProcessedHistory>();
    const linear = fakeLinear([issue("u1", "SCIM-1")]);
    const process = async (iss: LinearIssue): Promise<TicketProcessingResult> => {
      seen.push(iss.identifier);
      return { status: "accepted", prNumber: 1, prUrl: "u", branch: "b", filesWritten: 1 };
    };

    const opts: PollOptions = { linear, teamKey: "SCIM", process, history };
    await runOnePoll(opts);
    await runOnePoll(opts);
    await runOnePoll(opts);

    expect(seen).toEqual(["SCIM-1"]); // processed only on first poll
  });

  it("re-processes a ticket whose prior result was 'failed' (retry path)", async () => {
    const seen: string[] = [];
    const history = new Map<string, ProcessedHistory>();
    const linear = fakeLinear([issue("u1", "SCIM-1")]);
    let callCount = 0;
    const process = async (iss: LinearIssue): Promise<TicketProcessingResult> => {
      seen.push(iss.identifier);
      callCount++;
      // First call fails; subsequent calls accept
      if (callCount === 1) return { status: "failed", reason: "github 500" };
      return { status: "accepted", prNumber: 1, prUrl: "u", branch: "b", filesWritten: 1 };
    };

    const opts: PollOptions = { linear, teamKey: "SCIM", process, history };
    await runOnePoll(opts);
    await runOnePoll(opts);
    await runOnePoll(opts);

    // Should have been re-attempted after the fail, then deduped after accept
    expect(seen.length).toBe(2);
    expect(seen).toEqual(["SCIM-1", "SCIM-1"]);
  });

  it("does NOT re-process a rejected ticket (rejection is terminal — fix the ticket and re-open)", async () => {
    const seen: string[] = [];
    const history = new Map<string, ProcessedHistory>();
    const linear = fakeLinear([issue("u1", "SCIM-1", "no yaml")]);
    const process = async (): Promise<TicketProcessingResult> => {
      seen.push("called");
      return { status: "rejected", reason: "no-yaml-frontmatter", errors: ["."] };
    };

    const opts: PollOptions = { linear, teamKey: "SCIM", process, history };
    await runOnePoll(opts);
    await runOnePoll(opts);
    expect(seen).toEqual(["called"]); // only once
  });
});

describe("runOnePoll — error isolation", () => {
  it("a thrown error on one ticket does not kill the poll; remaining tickets still process", async () => {
    const seen: string[] = [];
    const history = new Map<string, ProcessedHistory>();
    const linear = fakeLinear([
      issue("u1", "SCIM-1"),
      issue("u2", "SCIM-2"),
      issue("u3", "SCIM-3"),
    ]);
    const process = async (iss: LinearIssue): Promise<TicketProcessingResult> => {
      seen.push(iss.identifier);
      if (iss.identifier === "SCIM-2") throw new Error("boom");
      return { status: "accepted", prNumber: 1, prUrl: "u", branch: "b", filesWritten: 1 };
    };

    const opts: PollOptions = { linear, teamKey: "SCIM", process, history };
    const report = await runOnePoll(opts);

    expect(seen).toEqual(["SCIM-1", "SCIM-2", "SCIM-3"]);
    expect(report.processed).toBe(3);
    expect(report.accepted).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.rejected).toBe(0);
  });

  it("a Linear list failure returns a report with processed=0 (no crash)", async () => {
    const history = new Map<string, ProcessedHistory>();
    const linear: LinearClient = {
      async listIssuesByTeam() { throw new Error("linear down"); },
      async getIssue() { return null; },
      async commentOnIssue() { /* noop */ },
      async updateIssueState() { /* noop */ },
    };
    const process = async (): Promise<TicketProcessingResult> => {
      throw new Error("should not be called");
    };

    const opts: PollOptions = { linear, teamKey: "SCIM", process, history };
    const report = await runOnePoll(opts);
    expect(report.processed).toBe(0);
    expect(report.listError).toMatch(/linear down/);
  });
});

describe("runOnePoll — report shape", () => {
  it("aggregates per-status counts", async () => {
    const history = new Map<string, ProcessedHistory>();
    const linear = fakeLinear([
      issue("u1", "A"),
      issue("u2", "B"),
      issue("u3", "C"),
      issue("u4", "D"),
    ]);
    const process = async (iss: LinearIssue): Promise<TicketProcessingResult> => {
      if (iss.identifier === "A") return { status: "accepted", prNumber: 1, prUrl: "u", branch: "b", filesWritten: 1 };
      if (iss.identifier === "B") return { status: "rejected", reason: "no-yaml-frontmatter", errors: ["."] };
      if (iss.identifier === "C") return { status: "rejected", reason: "schema-violation", errors: ["."] };
      return { status: "failed", reason: "." };
    };
    const report = await runOnePoll({ linear, teamKey: "SCIM", process, history });
    expect(report.processed).toBe(4);
    expect(report.accepted).toBe(1);
    expect(report.rejected).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.skipped).toBe(0);
  });

  it("counts skipped tickets from history lookups", async () => {
    const history = new Map<string, ProcessedHistory>();
    history.set("SCIM-1", { lastStatus: "accepted", at: "2026-05-05T13:00:00Z" });
    const linear = fakeLinear([
      issue("u1", "SCIM-1"),
      issue("u2", "SCIM-2"),
    ]);
    const process = async (iss: LinearIssue): Promise<TicketProcessingResult> => ({
      status: "accepted", prNumber: 1, prUrl: "u", branch: "b", filesWritten: 1,
    });
    const report = await runOnePoll({ linear, teamKey: "SCIM", process, history });
    expect(report.skipped).toBe(1);
    expect(report.processed).toBe(1);
  });
});
