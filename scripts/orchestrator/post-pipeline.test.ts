/**
 * Post-pipeline integration test — end-to-end orchestrator composition.
 *
 * Covers the PR-is-open → checks-green → smoke → manifest → Linear
 * comment chain. Every external is a fake; the TEST VERIFIES the
 * composition logic, not any single piece (those have unit coverage).
 *
 * Per GOLDEN RULE + EVAL LAW:
 *   - GOLDEN: this is the surface-scoped verify for the post-pipeline
 *     composition. Running the full unit suite would NOT catch a
 *     regression where the watcher fires but the manifest never gets
 *     built.
 *   - EVAL: structural invariants of the end-to-end flow (counts of
 *     smoke runs, manifest signs, comments posted) are asserted as a
 *     golden shape.
 */
import { describe, it, expect } from "vitest";
import { runPostPipeline } from "./post-pipeline.js";
import type { GitHubClient } from "../github/github-client.js";
import type { CheckRun } from "../github/types.js";
import type { LinearClient } from "../linear/linear-client.js";
import type { SmokeReport } from "../smoke/run-smoke.js";
import type { PromotionManifest, PreprodVerify, SigningKey } from "../promotion-manifest/types.js";

const REPO = { owner: "example", repo: "connectors" };
const SIGNING_KEY: SigningKey = { id: "test-current", secret: "a".repeat(64) };

function fakeGithub(checkSequence: CheckRun[][]): GitHubClient {
  let tick = 0;
  return {
    async createBranch() { /* unused */ },
    async writeFile() { /* unused */ },
    async openPr() { return { number: 1, url: "u", nodeId: "PR_1" }; },
    async getCheckRuns() {
      const runs = checkSequence[Math.min(tick, checkSequence.length - 1)] ?? [];
      tick++;
      return runs;
    },
    async commentOnPr() { /* noop */ },
  };
}

interface LinearRecord {
  comments: string[];
  stateChanges: string[];
}

function fakeLinear(rec: LinearRecord): LinearClient {
  return {
    async listIssuesByTeam() { return []; },
    async getIssue() { return null; },
    async commentOnIssue(o) { rec.comments.push(o.body); },
    async updateIssueState(o) { rec.stateChanges.push(o.stateId); },
  };
}

function fakeSmoke(report: SmokeReport): () => Promise<SmokeReport> {
  return async () => report;
}

const GREEN_SMOKE: SmokeReport = {
  ran_at: "2026-05-05T14:00:00Z",
  smoke_test_passed: true,
  log_errors_count: 0,
  steps: [
    { name: "scim-provision", ok: true, durationMs: 50 },
    { name: "scim-patch-deactivate", ok: true, durationMs: 40 },
    { name: "target-verify-deactivated", ok: true, durationMs: 30 },
  ],
};

const RED_SMOKE: SmokeReport = {
  ran_at: "2026-05-05T14:00:00Z",
  smoke_test_passed: false,
  log_errors_count: 1,
  steps: [
    { name: "scim-provision", ok: true, durationMs: 50 },
    { name: "scim-patch-deactivate", ok: true, durationMs: 40 },
    { name: "target-verify-deactivated", ok: false, durationMs: 30, error: "target reports enabled=true" },
  ],
};

function manifestInputs() {
  const preprodVerify: PreprodVerify = {
    ran_at: "2026-05-05T14:00:00Z",
    tsc_clean: true,
    vitest_passed: "386/386",
    oin_spec_tests_passed: "12/12",
    tf_plan_empty: true,
    smoke_test_passed: true,
    log_errors_count: 0,
  };
  return {
    customer_slug: "acme-hr",
    ticket_id: "SCIM-42",
    git_commit: "abc".repeat(13) + "a",
    git_tag: "v1.0.0-acme-hr",
    preprod_tenant: "demo-customer-a-staging.oktapreview.com",
    prod_tenant: "demo-customer-a-prod.okta.com",
    terraform_module_version: "0.3.1",
    fixtures_hash: "1".repeat(64),
    preprod_verify: preprodVerify,
    approver_github_username: "lmigault",
  };
}

describe("runPostPipeline — passed chain", () => {
  it("CI green → runSmoke → buildManifest → signManifest → Linear comment with manifest SHA", async () => {
    const lrec: LinearRecord = { comments: [], stateChanges: [] };
    const github = fakeGithub([[
      { name: "vitest", status: "completed", conclusion: "success", detailsUrl: null },
      { name: "tsc", status: "completed", conclusion: "success", detailsUrl: null },
    ]]);

    const result = await runPostPipeline({
      github,
      linear: fakeLinear(lrec),
      runSmoke: fakeSmoke(GREEN_SMOKE),
      manifestInputs: manifestInputs(),
      signingKey: SIGNING_KEY,
      repo: REPO,
      pr: { number: 42, headSha: "sha-head-42" },
      linearIssueId: "issue-uuid-1",
      doneStateId: "state-done",
      sleep: async () => { /* instant */ },
    });

    expect(result.status).toBe("promoted-ready");
    expect(result.manifest).toBeDefined();
    expect(result.manifest?.signature).toMatch(/^[a-f0-9]{64}$/);

    // Linear comment mentions the manifest SHA for traceability
    const lastComment = lrec.comments[lrec.comments.length - 1] ?? "";
    expect(lastComment.toLowerCase()).toMatch(/manifest|signed|promote/);
    expect(lastComment).toContain(result.manifest?.signature ?? "UNREACHABLE");

    // State advanced to done
    expect(lrec.stateChanges).toContain("state-done");
  });

  it("CI red → posts rejection comment with failing check names, does NOT sign a manifest", async () => {
    const lrec: LinearRecord = { comments: [], stateChanges: [] };
    const github = fakeGithub([[
      { name: "vitest", status: "completed", conclusion: "success", detailsUrl: null },
      { name: "tsc", status: "completed", conclusion: "failure", detailsUrl: "https://x/tsc" },
      { name: "runbook", status: "completed", conclusion: "failure", detailsUrl: "https://x/runbook" },
    ]]);

    const result = await runPostPipeline({
      github,
      linear: fakeLinear(lrec),
      runSmoke: fakeSmoke(GREEN_SMOKE),
      manifestInputs: manifestInputs(),
      signingKey: SIGNING_KEY,
      repo: REPO,
      pr: { number: 42, headSha: "sha-head-42" },
      linearIssueId: "issue-uuid-1",
      doneStateId: "state-done",
      sleep: async () => { /* instant */ },
    });

    expect(result.status).toBe("ci-failed");
    expect(result.manifest).toBeUndefined();

    const lastComment = lrec.comments[lrec.comments.length - 1] ?? "";
    expect(lastComment).toContain("tsc");
    expect(lastComment).toContain("runbook");
    // doneStateId should NOT have been triggered on a failed run
    expect(lrec.stateChanges).not.toContain("state-done");
  });

  it("smoke red (connector lies) → posts rejection, does NOT sign manifest", async () => {
    const lrec: LinearRecord = { comments: [], stateChanges: [] };
    const github = fakeGithub([[
      { name: "vitest", status: "completed", conclusion: "success", detailsUrl: null },
    ]]);

    const result = await runPostPipeline({
      github,
      linear: fakeLinear(lrec),
      runSmoke: fakeSmoke(RED_SMOKE),
      manifestInputs: manifestInputs(),
      signingKey: SIGNING_KEY,
      repo: REPO,
      pr: { number: 42, headSha: "sha-head-42" },
      linearIssueId: "issue-uuid-1",
      doneStateId: "state-done",
      sleep: async () => { /* instant */ },
    });

    expect(result.status).toBe("smoke-failed");
    expect(result.manifest).toBeUndefined();

    const lastComment = lrec.comments[lrec.comments.length - 1] ?? "";
    expect(lastComment.toLowerCase()).toMatch(/smoke|target|deactivation/);
    expect(lrec.stateChanges).not.toContain("state-done");
  });

  it("CI timeout → posts timeout comment, does NOT sign manifest", async () => {
    const lrec: LinearRecord = { comments: [], stateChanges: [] };
    const github = fakeGithub([[
      { name: "vitest", status: "in_progress", conclusion: null, detailsUrl: null },
    ]]);

    const result = await runPostPipeline({
      github,
      linear: fakeLinear(lrec),
      runSmoke: fakeSmoke(GREEN_SMOKE),
      manifestInputs: manifestInputs(),
      signingKey: SIGNING_KEY,
      repo: REPO,
      pr: { number: 42, headSha: "sha-head-42" },
      linearIssueId: "issue-uuid-1",
      doneStateId: "state-done",
      sleep: async () => { /* instant */ },
      maxChecksPolls: 2,
    });

    expect(result.status).toBe("ci-timeout");
    const lastComment = lrec.comments[lrec.comments.length - 1] ?? "";
    expect(lastComment.toLowerCase()).toMatch(/timeout|in_progress|still running/);
  });
});

describe("runPostPipeline — integration invariants", () => {
  it("happy path produces EXACTLY one Linear comment AND one state advance", async () => {
    const lrec: LinearRecord = { comments: [], stateChanges: [] };
    const github = fakeGithub([[
      { name: "vitest", status: "completed", conclusion: "success", detailsUrl: null },
    ]]);

    await runPostPipeline({
      github,
      linear: fakeLinear(lrec),
      runSmoke: fakeSmoke(GREEN_SMOKE),
      manifestInputs: manifestInputs(),
      signingKey: SIGNING_KEY,
      repo: REPO,
      pr: { number: 42, headSha: "sha-head-42" },
      linearIssueId: "issue-uuid-1",
      doneStateId: "state-done",
      sleep: async () => { /* instant */ },
    });

    // Avoid noisy duplicate state advances or comments
    expect(lrec.comments.length).toBe(1);
    expect(lrec.stateChanges.length).toBe(1);
  });

  it("failure paths produce EXACTLY one Linear comment AND zero state advances", async () => {
    const lrec: LinearRecord = { comments: [], stateChanges: [] };
    const github = fakeGithub([[
      { name: "vitest", status: "completed", conclusion: "failure", detailsUrl: null },
    ]]);

    await runPostPipeline({
      github,
      linear: fakeLinear(lrec),
      runSmoke: fakeSmoke(GREEN_SMOKE),
      manifestInputs: manifestInputs(),
      signingKey: SIGNING_KEY,
      repo: REPO,
      pr: { number: 42, headSha: "sha-head-42" },
      linearIssueId: "issue-uuid-1",
      doneStateId: "state-done",
      sleep: async () => { /* instant */ },
    });

    expect(lrec.comments.length).toBe(1);
    expect(lrec.stateChanges.length).toBe(0);
  });

  it("signed manifest is verifiable with the same key used to sign it", async () => {
    const lrec: LinearRecord = { comments: [], stateChanges: [] };
    const github = fakeGithub([[
      { name: "vitest", status: "completed", conclusion: "success", detailsUrl: null },
    ]]);

    const result = await runPostPipeline({
      github,
      linear: fakeLinear(lrec),
      runSmoke: fakeSmoke(GREEN_SMOKE),
      manifestInputs: manifestInputs(),
      signingKey: SIGNING_KEY,
      repo: REPO,
      pr: { number: 42, headSha: "sha-head-42" },
      linearIssueId: "issue-uuid-1",
      doneStateId: "state-done",
      sleep: async () => { /* instant */ },
    });

    expect(result.status).toBe("promoted-ready");
    expect(result.manifest).toBeDefined();

    // Independently verify using the same key — catches regressions in
    // the sign/verify round-trip that per-unit tests might miss.
    const { verifyManifest } = await import("../promotion-manifest/sign.js");
    const verification = verifyManifest(result.manifest!, { current: SIGNING_KEY });
    expect(verification.valid).toBe(true);
  });

  it("signed manifest carries the preprod_verify field matching the smoke report", async () => {
    const lrec: LinearRecord = { comments: [], stateChanges: [] };
    const github = fakeGithub([[
      { name: "vitest", status: "completed", conclusion: "success", detailsUrl: null },
    ]]);

    const result = await runPostPipeline({
      github,
      linear: fakeLinear(lrec),
      runSmoke: fakeSmoke(GREEN_SMOKE),
      manifestInputs: manifestInputs(),
      signingKey: SIGNING_KEY,
      repo: REPO,
      pr: { number: 42, headSha: "sha-head-42" },
      linearIssueId: "issue-uuid-1",
      doneStateId: "state-done",
      sleep: async () => { /* instant */ },
    });

    expect(result.status).toBe("promoted-ready");
    const manifest: PromotionManifest = result.manifest!.manifest;
    expect(manifest.preprod_verify.smoke_test_passed).toBe(true);
    expect(manifest.preprod_verify.log_errors_count).toBe(0);
  });
});
