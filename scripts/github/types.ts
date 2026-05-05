/**
 * GitHub-client types — orchestrator-facing shapes, NOT octokit types.
 *
 * Keeps octokit's massive type surface out of downstream callers so a
 * future swap (to a different GitHub lib, or to a fake for CI) is a
 * one-file edit. All methods return normalized scalars.
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface FileChange {
  path: string;
  content: string;
  /** Per-file commit message. Used when writing one file per commit. */
  message: string;
}

export interface CreateBranchOptions extends RepoRef {
  /** Existing branch to start from (usually "main"). */
  fromBranch: string;
  /** New branch name to create. */
  newBranch: string;
}

export interface WriteFileOptions extends RepoRef {
  branch: string;
  path: string;
  content: string;
  message: string;
}

export interface OpenPrOptions extends RepoRef {
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface OpenPrResult {
  number: number;
  url: string;
  nodeId: string;
}

export interface GetCheckRunsOptions extends RepoRef {
  /** SHA (commit hash) or branch name. */
  ref: string;
}

export interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | "stale" | null;
  detailsUrl: string | null;
}

export interface CommentOnPrOptions extends RepoRef {
  issueNumber: number;
  body: string;
}

export class GitHubClientError extends Error {
  constructor(public readonly status: number | undefined, message: string) {
    super(message);
    this.name = "GitHubClientError";
  }
}
