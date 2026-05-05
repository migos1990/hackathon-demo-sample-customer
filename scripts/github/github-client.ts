/**
 * GitHub client wrapper for the orchestrator.
 *
 * Thin typed surface over Octokit — the orchestrator calls five
 * operations (createBranch, writeFile, openPr, getCheckRuns,
 * commentOnPr) and this module exposes exactly those. Callers never
 * import from `octokit` directly, so a swap to a different lib or a
 * GitHub App-based client in the future is a one-file edit.
 *
 * Defense in depth:
 *   - Token value redacted from any SDK-thrown error message before
 *     rethrowing as GitHubClientError. Octokit puts the Authorization
 *     header in some transport-level error strings; unredacted logs
 *     would leak the PAT.
 *   - Fail-fast on empty token to avoid mystery 401s at call time.
 *   - All methods return normalized scalars — no Octokit types leak.
 */
import { Octokit } from "octokit";
import {
  GitHubClientError,
  type CreateBranchOptions,
  type WriteFileOptions,
  type OpenPrOptions,
  type OpenPrResult,
  type GetCheckRunsOptions,
  type CheckRun,
  type CommentOnPrOptions,
} from "./types.js";

/**
 * Duck-typed slice of the Octokit surface we actually call. Lets tests
 * substitute a fake without subclassing Octokit (which has a massive
 * generic surface). Intentionally NOT exhaustive — we list every call
 * site so a new API usage forces a type-level acknowledgement.
 */
export interface OctokitLike {
  rest: {
    repos: {
      getBranch(args: { owner: string; repo: string; branch: string }): Promise<{ data: { commit: { sha: string } } }>;
      createOrUpdateFileContents(args: {
        owner: string; repo: string; branch: string; path: string; message: string; content: string; sha?: string;
      }): Promise<{ data: { commit: { sha: string }; content: { sha: string } | null } }>;
      getContent(args: {
        owner: string; repo: string; ref?: string; path: string;
      }): Promise<{ data: { sha: string; type: string } | unknown }>;
    };
    git: {
      createRef(args: { owner: string; repo: string; ref: string; sha: string }): Promise<{ data: { ref: string; object: { sha: string } } }>;
    };
    pulls: {
      create(args: { owner: string; repo: string; head: string; base: string; title: string; body: string }): Promise<{ data: { number: number; html_url: string; node_id: string } }>;
    };
    issues: {
      createComment(args: { owner: string; repo: string; issue_number: number; body: string }): Promise<{ data: { id: number } }>;
    };
    checks: {
      listForRef(args: { owner: string; repo: string; ref: string }): Promise<{ data: { total_count: number; check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url: string | null }> } }>;
    };
  };
}

export interface GitHubClientOptions {
  token: string;
  /** Inject for tests; defaults to a real Octokit instance. */
  octokit?: OctokitLike;
}

export interface GitHubClient {
  createBranch(opts: CreateBranchOptions): Promise<void>;
  writeFile(opts: WriteFileOptions): Promise<void>;
  openPr(opts: OpenPrOptions): Promise<OpenPrResult>;
  getCheckRuns(opts: GetCheckRunsOptions): Promise<CheckRun[]>;
  commentOnPr(opts: CommentOnPrOptions): Promise<void>;
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  if (!options.token) {
    throw new Error("createGitHubClient: token is required (got empty string)");
  }

  const token = options.token;
  const octokit: OctokitLike = options.octokit ?? (new Octokit({ auth: token }) as unknown as OctokitLike);

  function wrap<T>(promise: Promise<T>): Promise<T> {
    return promise.catch((err: unknown) => {
      throw wrapError(err, token);
    });
  }

  return {
    async createBranch(opts) {
      // Get the sha of fromBranch first, then create a ref to it.
      const { data } = await wrap(
        octokit.rest.repos.getBranch({ owner: opts.owner, repo: opts.repo, branch: opts.fromBranch }),
      );
      await wrap(
        octokit.rest.git.createRef({
          owner: opts.owner,
          repo: opts.repo,
          ref: `refs/heads/${opts.newBranch}`,
          sha: data.commit.sha,
        }),
      );
    },

    async writeFile(opts) {
      // Fetch existing sha if the file already exists (required for updates).
      // 404 is expected + fine — means it's a new file.
      let existingSha: string | undefined;
      try {
        const { data } = await octokit.rest.repos.getContent({
          owner: opts.owner,
          repo: opts.repo,
          ref: opts.branch,
          path: opts.path,
        });
        if (isFileContent(data)) existingSha = data.sha;
      } catch (err) {
        if (!is404(err)) throw wrapError(err, token);
      }

      await wrap(
        octokit.rest.repos.createOrUpdateFileContents({
          owner: opts.owner,
          repo: opts.repo,
          branch: opts.branch,
          path: opts.path,
          message: opts.message,
          content: Buffer.from(opts.content, "utf8").toString("base64"),
          ...(existingSha !== undefined && { sha: existingSha }),
        }),
      );
    },

    async openPr(opts) {
      const { data } = await wrap(
        octokit.rest.pulls.create({
          owner: opts.owner,
          repo: opts.repo,
          head: opts.head,
          base: opts.base,
          title: opts.title,
          body: opts.body,
        }),
      );
      return { number: data.number, url: data.html_url, nodeId: data.node_id };
    },

    async getCheckRuns(opts) {
      const { data } = await wrap(
        octokit.rest.checks.listForRef({ owner: opts.owner, repo: opts.repo, ref: opts.ref }),
      );
      return data.check_runs.map((run) => ({
        name: run.name,
        status: run.status as CheckRun["status"],
        conclusion: run.conclusion as CheckRun["conclusion"],
        detailsUrl: run.html_url ?? null,
      }));
    },

    async commentOnPr(opts) {
      await wrap(
        octokit.rest.issues.createComment({
          owner: opts.owner,
          repo: opts.repo,
          issue_number: opts.issueNumber,
          body: opts.body,
        }),
      );
    },
  };
}

export function fromEnv(opts: { octokit?: OctokitLike } = {}): GitHubClient {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "fromEnv: GITHUB_TOKEN is not set — add it to .env (see .env.example)",
    );
  }
  return createGitHubClient({
    token,
    ...(opts.octokit !== undefined && { octokit: opts.octokit }),
  });
}

function isFileContent(data: unknown): data is { sha: string; type: string } {
  if (typeof data !== "object" || data === null) return false;
  const d = data as { sha?: unknown; type?: unknown };
  return typeof d.sha === "string" && d.type === "file";
}

function is404(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { status?: unknown }).status === 404;
}

function wrapError(err: unknown, token: string): GitHubClientError {
  const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
  const rawMessage = err instanceof Error ? err.message : String(err);
  const safeMessage = token ? rawMessage.split(token).join("[REDACTED]") : rawMessage;
  return new GitHubClientError(typeof status === "number" ? status : undefined, `github: ${safeMessage}`);
}
