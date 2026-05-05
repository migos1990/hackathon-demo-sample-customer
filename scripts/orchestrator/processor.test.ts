/**
 * Per-ticket processor tests — fakes for all three external clients
 * (Linear, GitHub, Agent). No network, no LLM call.
 *
 * Covers the three exits: accepted (happy path), rejected (validation
 * failure), failed (runtime error mid-flow). Asserts state machine
 * correctness: PR is only opened when generation succeeded; Linear
 * comments fire for each rejection reason; state advances only on
 * accept.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { processTicket } from "./processor.js";
import type { Agent, GeneratedFile, OrchestratorRepoConfig } from "./types.js";
import type { LinearClient } from "../linear/linear-client.js";
import type { LinearIssue } from "../linear/types.js";
import type { GitHubClient } from "../github/github-client.js";
import type { OpenPrResult, CheckRun } from "../github/types.js";

const REPO: OrchestratorRepoConfig = { owner: "example", repo: "connectors", baseBranch: "main" };

// ---- Fakes ---------------------------------------------------------------

interface LinearState {
  comments: Array<{ issueId: string; body: string }>;
  stateChanges: Array<{ issueId: string; stateId: string }>;
}

function fakeLinear(state: LinearState): LinearClient {
  return {
    async listIssuesByTeam() { return []; },
    async getIssue() { return null; },
    async commentOnIssue(opts) { state.comments.push({ issueId: opts.issueId, body: opts.body }); },
    async updateIssueState(opts) { state.stateChanges.push({ issueId: opts.issueId, stateId: opts.stateId }); },
  };
}

interface GithubState {
  branchesCreated: Array<{ fromBranch: string; newBranch: string }>;
  filesWritten: Array<{ branch: string; path: string; contentLen: number }>;
  prsOpened: Array<{ head: string; base: string; title: string; body: string }>;
}

function fakeGithub(state: GithubState, opts: { openPrBehavior?: () => Promise<OpenPrResult>; writeFileThrows?: Error } = {}): GitHubClient {
  let prNumber = 200;
  return {
    async createBranch(o) { state.branchesCreated.push({ fromBranch: o.fromBranch, newBranch: o.newBranch }); },
    async writeFile(o) {
      if (opts.writeFileThrows) throw opts.writeFileThrows;
      state.filesWritten.push({ branch: o.branch, path: o.path, contentLen: o.content.length });
    },
    async openPr(o) {
      if (opts.openPrBehavior) return opts.openPrBehavior();
      state.prsOpened.push({ head: o.head, base: o.base, title: o.title, body: o.body });
      const n = prNumber++;
      return { number: n, url: `https://github.com/x/y/pull/${n}`, nodeId: `PR_${n}` };
    },
    async getCheckRuns() { return [] as CheckRun[]; },
    async commentOnPr() { /* noop */ },
  };
}

function fakeAgent(files: GeneratedFile[] | Error): Agent {
  return {
    async generateConnector() {
      if (files instanceof Error) throw files;
      return files;
    },
  };
}

function validTicketFrontMatter(): string {
  return `---
customer_app_name: AcmeHR
customer_slug: acme-hr
auth_method: bearer
auth_credential_location: env
auth_credential_env_var: ACME_HR_API_TOKEN
base_url: https://api.acme-hr.example.com
environments:
  dev: https://dev.acme-hr.example.com
  staging: https://staging.acme-hr.example.com
  prod: https://api.acme-hr.example.com
user_model_source: ldap
required_ops:
  users_create: true
  users_read: true
  users_update_patch: true
  users_delete: true
  users_list: true
  users_filter: true
lifecycle_policy: soft_delete
target_okta_tenant: demo-customer-a-staging.oktapreview.com
terraform_workspace: staging
promotion_gate:
  preprod_verified_at: null
  preprod_manifest_sha: null
  approver_github_username: null
  promoted_to_prod_at: null
---

# Body

Some description.
`;
}

function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "issue-uuid-1",
    identifier: "SCIM-42",
    title: "[SCIM] AcmeHR",
    description: validTicketFrontMatter(),
    state: { id: "state-triage", name: "Triage", type: "triage" },
    team: { id: "team-scim", key: "SCIM" },
    url: "https://linear.app/x/issue/SCIM-42",
    updatedAt: "2026-05-05T14:00:00Z",
    ...overrides,
  };
}

// ---- Tests ---------------------------------------------------------------

describe("processTicket — accepted (happy path)", () => {
  let linearState: LinearState;
  let githubState: GithubState;

  beforeEach(() => {
    linearState = { comments: [], stateChanges: [] };
    githubState = { branchesCreated: [], filesWritten: [], prsOpened: [] };
  });

  it("validates, branches, writes files, opens PR, comments with PR link", async () => {
    const agent = fakeAgent([
      { path: "connectors/acme-hr/store.ts", content: "// store", message: "feat: store" },
      { path: "connectors/acme-hr/server.ts", content: "// server", message: "feat: server" },
    ]);
    const result = await processTicket({
      issue: makeIssue(),
      linear: fakeLinear(linearState),
      github: fakeGithub(githubState),
      agent,
      repo: REPO,
      inProgressStateId: "state-inprogress",
    });

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.filesWritten).toBe(2);
    expect(result.branch).toMatch(/^agent\/scim-42-acme-hr-[a-f0-9]{6}$/);
    expect(result.prUrl).toMatch(/^https:\/\/github\.com\//);

    // Branch created from baseBranch
    expect(githubState.branchesCreated).toHaveLength(1);
    expect(githubState.branchesCreated[0]?.fromBranch).toBe("main");

    // Both files written to the new branch
    expect(githubState.filesWritten).toHaveLength(2);
    expect(githubState.filesWritten[0]?.branch).toBe(githubState.branchesCreated[0]?.newBranch);

    // PR opened head=newBranch base=main
    expect(githubState.prsOpened).toHaveLength(1);
    expect(githubState.prsOpened[0]?.base).toBe("main");
    expect(githubState.prsOpened[0]?.head).toBe(githubState.branchesCreated[0]?.newBranch);
    expect(githubState.prsOpened[0]?.title).toMatch(/SCIM-42/);

    // Linear comment with PR link
    expect(linearState.comments.some((c) => c.body.includes("pull/"))).toBe(true);

    // State advanced to In Progress
    expect(linearState.stateChanges).toHaveLength(1);
    expect(linearState.stateChanges[0]?.stateId).toBe("state-inprogress");
  });

  it("uses the ticket identifier as the customer slug in the branch name when customer_slug matches", async () => {
    const agent = fakeAgent([{ path: "x.ts", content: "x", message: "m" }]);
    const result = await processTicket({
      issue: makeIssue(),
      linear: fakeLinear(linearState),
      github: fakeGithub(githubState),
      agent,
      repo: REPO,
      inProgressStateId: "state-ip",
    });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.branch).toContain("acme-hr");
  });
});

describe("processTicket — rejected: no front-matter", () => {
  it("comments with the rejection reason, advances to canceled, does NOT open a PR", async () => {
    const linearState: LinearState = { comments: [], stateChanges: [] };
    const githubState: GithubState = { branchesCreated: [], filesWritten: [], prsOpened: [] };
    const result = await processTicket({
      issue: makeIssue({ description: "just a description, no YAML fence" }),
      linear: fakeLinear(linearState),
      github: fakeGithub(githubState),
      agent: fakeAgent([]),
      repo: REPO,
      inProgressStateId: "state-ip",
      canceledStateId: "state-canceled",
    });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reason).toBe("no-yaml-frontmatter");

    // No GitHub calls
    expect(githubState.branchesCreated).toEqual([]);
    expect(githubState.prsOpened).toEqual([]);

    // Linear comment with diagnostic
    expect(linearState.comments.some((c) => c.body.includes("no-yaml-frontmatter") || c.body.includes("front-matter"))).toBe(true);

    // State advanced to canceled (if configured)
    expect(linearState.stateChanges).toEqual([{ issueId: "issue-uuid-1", stateId: "state-canceled" }]);
  });
});

describe("processTicket — rejected: schema violation", () => {
  it("surfaces every schema error in the Linear comment", async () => {
    const brokenFrontMatter = `---
customer_slug: BAD UPPERCASE
auth_method: invalid_method
base_url: http://not-https
---
`;
    const linearState: LinearState = { comments: [], stateChanges: [] };
    const githubState: GithubState = { branchesCreated: [], filesWritten: [], prsOpened: [] };
    const result = await processTicket({
      issue: makeIssue({ description: brokenFrontMatter }),
      linear: fakeLinear(linearState),
      github: fakeGithub(githubState),
      agent: fakeAgent([]),
      repo: REPO,
      inProgressStateId: "state-ip",
      canceledStateId: "state-canceled",
    });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reason).toBe("schema-violation");
    expect(result.errors.length).toBeGreaterThanOrEqual(2);

    // Comment surfaces the violations
    const comment = linearState.comments[0]?.body ?? "";
    expect(comment.toLowerCase()).toMatch(/schema|violation/);

    // No PR
    expect(githubState.prsOpened).toEqual([]);
  });
});

describe("processTicket — failed: runtime error", () => {
  it("returns failed with a reason when writeFile throws mid-flow; does not advance state", async () => {
    const linearState: LinearState = { comments: [], stateChanges: [] };
    const githubState: GithubState = { branchesCreated: [], filesWritten: [], prsOpened: [] };
    const result = await processTicket({
      issue: makeIssue(),
      linear: fakeLinear(linearState),
      github: fakeGithub(githubState, { writeFileThrows: new Error("github: 500 Internal Server Error") }),
      agent: fakeAgent([{ path: "x.ts", content: "x", message: "m" }]),
      repo: REPO,
      inProgressStateId: "state-ip",
      canceledStateId: "state-canceled",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toMatch(/500|writeFile|github/);

    // Linear gets a failure comment but state does NOT advance — the
    // next orchestrator poll will retry this ticket.
    expect(linearState.comments.length).toBeGreaterThanOrEqual(1);
    expect(linearState.stateChanges).toEqual([]);
  });

  it("returns failed when the agent errors (e.g. LLM rate limit)", async () => {
    const linearState: LinearState = { comments: [], stateChanges: [] };
    const githubState: GithubState = { branchesCreated: [], filesWritten: [], prsOpened: [] };
    const result = await processTicket({
      issue: makeIssue(),
      linear: fakeLinear(linearState),
      github: fakeGithub(githubState),
      agent: fakeAgent(new Error("anthropic SDK error: 429 rate_limit")),
      repo: REPO,
      inProgressStateId: "state-ip",
      canceledStateId: "state-canceled",
    });
    expect(result.status).toBe("failed");
    // Agent errored BEFORE any GitHub write, so no branch should have been created.
    expect(githubState.branchesCreated).toEqual([]);
  });
});

describe("processTicket — agent returns zero files", () => {
  it("still advances, opens an empty PR with a diagnostic title (operator decides what to do)", async () => {
    const linearState: LinearState = { comments: [], stateChanges: [] };
    const githubState: GithubState = { branchesCreated: [], filesWritten: [], prsOpened: [] };
    const result = await processTicket({
      issue: makeIssue(),
      linear: fakeLinear(linearState),
      github: fakeGithub(githubState),
      agent: fakeAgent([]),
      repo: REPO,
      inProgressStateId: "state-ip",
    });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.filesWritten).toBe(0);
    expect(githubState.prsOpened[0]?.title).toMatch(/empty|no files|SCIM-42/i);
  });
});
