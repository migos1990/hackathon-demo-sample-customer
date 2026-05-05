/**
 * Linear client tests — fake fetch, no network.
 *
 * Covers listIssuesByTeam, getIssue, commentOnIssue, updateIssueState.
 * Live probe gated on LINEAR_API_KEY via scripts/linear/live-probe.ts.
 */
import { describe, it, expect } from "vitest";
import { createLinearClient } from "./linear-client.js";
import { LinearClientError } from "./types.js";

function fakeFetchOk(responseBody: unknown, status = 200): typeof fetch {
  return (async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const ISSUE_NODE = {
  id: "issue-uuid-1",
  identifier: "SCIM-42",
  title: "[SCIM] AcmeHR",
  description: "body",
  state: { id: "state-1", name: "Triage", type: "triage" },
  team: { id: "team-1", key: "SCIM" },
  url: "https://linear.app/x/issue/SCIM-42",
  updatedAt: "2026-05-05T14:00:00Z",
};

describe("createLinearClient — listIssuesByTeam", () => {
  it("parses the GraphQL response into normalized LinearIssue[]", async () => {
    const body = { data: { issues: { nodes: [ISSUE_NODE] } } };
    const client = createLinearClient({ apiKey: "lin_api_fake", fetchImpl: fakeFetchOk(body) });
    const issues = await client.listIssuesByTeam({ teamKey: "SCIM" });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.identifier).toBe("SCIM-42");
    expect(issues[0]?.state.name).toBe("Triage");
    expect(issues[0]?.team.key).toBe("SCIM");
  });

  it("returns an empty array when no tickets match", async () => {
    const body = { data: { issues: { nodes: [] } } };
    const client = createLinearClient({ apiKey: "lin_api_fake", fetchImpl: fakeFetchOk(body) });
    expect(await client.listIssuesByTeam({ teamKey: "SCIM" })).toEqual([]);
  });

  it("includes the Authorization header on every request", async () => {
    let observedHeaders: Record<string, string> = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      observedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = createLinearClient({ apiKey: "lin_api_real_token_value", fetchImpl });
    await client.listIssuesByTeam({ teamKey: "SCIM" });
    expect(observedHeaders.authorization || observedHeaders.Authorization).toBe("lin_api_real_token_value");
  });

  it("supports a stateType filter (only triage/unstarted by default)", async () => {
    let observedBody: string = "";
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      observedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = createLinearClient({ apiKey: "lin_api_fake", fetchImpl });
    await client.listIssuesByTeam({ teamKey: "SCIM", stateTypes: ["triage", "unstarted"] });
    expect(observedBody).toContain("triage");
    expect(observedBody).toContain("unstarted");
  });
});

describe("createLinearClient — getIssue", () => {
  it("fetches a single issue by identifier", async () => {
    const body = { data: { issue: ISSUE_NODE } };
    const client = createLinearClient({ apiKey: "lin_api_fake", fetchImpl: fakeFetchOk(body) });
    const issue = await client.getIssue({ identifier: "SCIM-42" });
    expect(issue?.identifier).toBe("SCIM-42");
    expect(issue?.description).toBe("body");
  });

  it("returns null when the issue is not found (GraphQL null data.issue)", async () => {
    const body = { data: { issue: null } };
    const client = createLinearClient({ apiKey: "lin_api_fake", fetchImpl: fakeFetchOk(body) });
    expect(await client.getIssue({ identifier: "SCIM-999" })).toBeNull();
  });
});

describe("createLinearClient — commentOnIssue", () => {
  it("posts a comment via commentCreate mutation", async () => {
    let observedBody = "";
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      observedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({
        data: { commentCreate: { success: true, comment: { id: "c-1", body: "ok" } } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = createLinearClient({ apiKey: "lin_api_fake", fetchImpl });
    await client.commentOnIssue({ issueId: "issue-uuid-1", body: "smoke green" });
    expect(observedBody).toContain("commentCreate");
    expect(observedBody).toContain("smoke green");
    expect(observedBody).toContain("issue-uuid-1");
  });

  it("throws LinearClientError when Linear returns success:false", async () => {
    const body = { data: { commentCreate: { success: false, comment: null } } };
    const client = createLinearClient({ apiKey: "lin_api_fake", fetchImpl: fakeFetchOk(body) });
    await expect(
      client.commentOnIssue({ issueId: "issue-uuid-1", body: "x" }),
    ).rejects.toBeInstanceOf(LinearClientError);
  });
});

describe("createLinearClient — updateIssueState", () => {
  it("updates via issueUpdate mutation", async () => {
    let observedBody = "";
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      observedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({
        data: { issueUpdate: { success: true, issue: ISSUE_NODE } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = createLinearClient({ apiKey: "lin_api_fake", fetchImpl });
    await client.updateIssueState({ issueId: "issue-uuid-1", stateId: "state-2" });
    expect(observedBody).toContain("issueUpdate");
    expect(observedBody).toContain("state-2");
  });
});

describe("createLinearClient — error handling", () => {
  it("throws LinearClientError with status on non-2xx responses", async () => {
    const fetchImpl = fakeFetchOk({ errors: [{ message: "Unauthorized" }] }, 401);
    const client = createLinearClient({ apiKey: "lin_api_bad", fetchImpl });
    await expect(client.listIssuesByTeam({ teamKey: "SCIM" })).rejects.toSatisfy(
      (err) => err instanceof LinearClientError && err.status === 401,
    );
  });

  it("throws LinearClientError on GraphQL-level errors (200 with errors[])", async () => {
    const fetchImpl = fakeFetchOk({ errors: [{ message: "Invalid query" }] }, 200);
    const client = createLinearClient({ apiKey: "lin_api_fake", fetchImpl });
    await expect(client.listIssuesByTeam({ teamKey: "SCIM" })).rejects.toBeInstanceOf(LinearClientError);
  });

  it("redacts the api key from thrown error messages", async () => {
    const realKey = "lin_api_very_secret_value_12345";
    const fetchImpl = (async () => {
      throw new Error(`network failure — Authorization: ${realKey}`);
    }) as unknown as typeof fetch;
    const client = createLinearClient({ apiKey: realKey, fetchImpl });
    await expect(client.listIssuesByTeam({ teamKey: "SCIM" })).rejects.toSatisfy(
      (err) => err instanceof LinearClientError && !err.message.includes(realKey),
    );
  });

  it("fail-fast on empty apiKey", () => {
    expect(() => createLinearClient({ apiKey: "", fetchImpl: fakeFetchOk({}) })).toThrow(/apiKey|api_key/i);
  });
});

describe("fromEnv", () => {
  it("reads LINEAR_API_KEY from process.env", async () => {
    const before = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_api_from_env";
    try {
      const { fromEnv } = await import("./linear-client.js");
      const client = fromEnv({ fetchImpl: fakeFetchOk({ data: { issues: { nodes: [] } } }) });
      expect(await client.listIssuesByTeam({ teamKey: "SCIM" })).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = before;
    }
  });

  it("fromEnv throws when LINEAR_API_KEY is unset", async () => {
    const before = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    try {
      const { fromEnv } = await import("./linear-client.js");
      expect(() => fromEnv()).toThrow(/LINEAR_API_KEY/);
    } finally {
      if (before !== undefined) process.env.LINEAR_API_KEY = before;
    }
  });
});
