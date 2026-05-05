/**
 * Linear client — raw fetch + GraphQL. No new dep.
 *
 * Scope: the four operations the orchestrator needs.
 *   listIssuesByTeam     — poll for new/open tickets on a team
 *   getIssue             — fetch full description (YAML front-matter) by identifier
 *   commentOnIssue       — post status updates back to the ticket
 *   updateIssueState     — advance the workflow (Triage → In Progress → Done, etc.)
 *
 * Why raw fetch not @linear/sdk: our call surface is four queries. The
 * SDK adds ~200KB + codegen for zero functional benefit at this scale.
 * If the surface grows (bulk operations, subscriptions), revisit.
 *
 * Auth: Linear's API uses the `Authorization` header with the personal
 * API key value directly (NO "Bearer" prefix — this differs from most
 * APIs). Documented in Linear's API docs.
 *
 * Integration doc: docs/integrations/linear.md (to follow — live probe
 * gated on LINEAR_API_KEY being set in .env).
 */
import { LinearClientError, type LinearIssue } from "./types.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export interface LinearClientOptions {
  apiKey: string;
  /** Inject for tests; defaults to ambient global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ListIssuesOptions {
  /** Team key (e.g. "SCIM"). Linear scopes tickets per team. */
  teamKey: string;
  /** Filter by state type. Defaults to open states: triage + unstarted. */
  stateTypes?: Array<LinearIssue["state"]["type"]>;
  /** Page size cap. Default 50; Linear's max is 250. */
  first?: number;
}

export interface GetIssueOptions {
  /** Team-scoped identifier (e.g. "SCIM-42"). */
  identifier: string;
}

export interface CommentOnIssueOptions {
  issueId: string;
  body: string;
}

export interface UpdateIssueStateOptions {
  issueId: string;
  stateId: string;
}

export interface LinearClient {
  listIssuesByTeam(opts: ListIssuesOptions): Promise<LinearIssue[]>;
  getIssue(opts: GetIssueOptions): Promise<LinearIssue | null>;
  commentOnIssue(opts: CommentOnIssueOptions): Promise<void>;
  updateIssueState(opts: UpdateIssueStateOptions): Promise<void>;
}

export function createLinearClient(options: LinearClientOptions): LinearClient {
  if (!options.apiKey) {
    throw new Error("createLinearClient: apiKey is required (got empty string)");
  }
  const apiKey = options.apiKey;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: {
          "authorization": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw wrapError(err, apiKey);
    }

    if (!res.ok) {
      const bodyText = await safeText(res);
      const safeBody = bodyText.split(apiKey).join("[REDACTED]");
      throw new LinearClientError(res.status, `linear: HTTP ${res.status} ${safeBody}`);
    }

    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors && body.errors.length > 0) {
      const messages = body.errors.map((e) => e.message).join("; ");
      throw new LinearClientError(undefined, `linear: GraphQL errors: ${messages}`);
    }
    if (!body.data) {
      throw new LinearClientError(undefined, "linear: response has no data field");
    }
    return body.data;
  }

  return {
    async listIssuesByTeam(opts) {
      const stateTypes = opts.stateTypes ?? ["triage", "unstarted"];
      const first = opts.first ?? 50;
      const query = `
        query ListIssues($teamKey: String!, $stateTypes: [String!], $first: Int!) {
          issues(
            filter: {
              team: { key: { eq: $teamKey } }
              state: { type: { in: $stateTypes } }
            }
            first: $first
            orderBy: updatedAt
          ) {
            nodes {
              id
              identifier
              title
              description
              state { id name type }
              team { id key }
              url
              updatedAt
            }
          }
        }
      `;
      const data = await graphql<{ issues: { nodes: LinearIssue[] } }>(query, {
        teamKey: opts.teamKey,
        stateTypes,
        first,
      });
      return data.issues.nodes;
    },

    async getIssue(opts) {
      const query = `
        query GetIssue($id: String!) {
          issue(id: $id) {
            id
            identifier
            title
            description
            state { id name type }
            team { id key }
            url
            updatedAt
          }
        }
      `;
      const data = await graphql<{ issue: LinearIssue | null }>(query, { id: opts.identifier });
      return data.issue;
    },

    async commentOnIssue(opts) {
      const query = `
        mutation CommentCreate($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
            comment { id body }
          }
        }
      `;
      const data = await graphql<{ commentCreate: { success: boolean; comment: { id: string; body: string } | null } }>(query, {
        input: { issueId: opts.issueId, body: opts.body },
      });
      if (!data.commentCreate.success) {
        throw new LinearClientError(undefined, "linear: commentCreate returned success:false");
      }
    },

    async updateIssueState(opts) {
      const query = `
        mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue {
              id identifier title description
              state { id name type } team { id key }
              url updatedAt
            }
          }
        }
      `;
      const data = await graphql<{ issueUpdate: { success: boolean } }>(query, {
        id: opts.issueId,
        input: { stateId: opts.stateId },
      });
      if (!data.issueUpdate.success) {
        throw new LinearClientError(undefined, "linear: issueUpdate returned success:false");
      }
    },
  };
}

export function fromEnv(opts: { fetchImpl?: typeof fetch } = {}): LinearClient {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("fromEnv: LINEAR_API_KEY is not set — add it to .env (see .env.example)");
  }
  return createLinearClient({
    apiKey,
    ...(opts.fetchImpl !== undefined && { fetchImpl: opts.fetchImpl }),
  });
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return "<unreadable>"; }
}

function wrapError(err: unknown, apiKey: string): LinearClientError {
  const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
  const rawMessage = err instanceof Error ? err.message : String(err);
  const safeMessage = apiKey ? rawMessage.split(apiKey).join("[REDACTED]") : rawMessage;
  return new LinearClientError(typeof status === "number" ? status : undefined, `linear: ${safeMessage}`);
}
