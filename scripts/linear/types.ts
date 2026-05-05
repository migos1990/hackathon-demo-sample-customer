/**
 * Linear client types — orchestrator-facing shapes.
 *
 * Intentionally a narrow subset of Linear's full schema. The orchestrator
 * needs: list open tickets on a team, fetch one ticket's full description,
 * post comments, advance state. That's it.
 */

export interface LinearIssue {
  id: string;
  /** Team-scoped short identifier (e.g. "SCIM-42"). */
  identifier: string;
  title: string;
  /** Markdown body. Contains the YAML front-matter the ticket template uses. */
  description: string | null;
  state: {
    id: string;
    name: string;
    type: "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled" | string;
  };
  team: {
    id: string;
    key: string;
  };
  url: string;
  updatedAt: string;
}

export interface LinearComment {
  id: string;
  body: string;
}

export class LinearClientError extends Error {
  constructor(public readonly status: number | undefined, message: string) {
    super(message);
    this.name = "LinearClientError";
  }
}
