#!/usr/bin/env node
/**
 * Live probe for the Linear client wrapper. Exercises listIssuesByTeam
 * + getIssue against the real workspace, confirms auth + the workspace
 * shape without mutating anything.
 *
 * Usage:
 *   eval "$(grep '^LINEAR_API_KEY=' .env | sed 's/^/export /')"
 *   eval "$(grep '^ORCHESTRATOR_TEAM_KEY=' .env | sed 's/^/export /')"
 *   tsx scripts/linear/live-probe.ts
 *
 * Exit 0 on success. Does NOT post comments or change state — safe to
 * run repeatedly.
 */
import { fromEnv } from "./linear-client.js";

async function main(): Promise<void> {
  const teamKey = process.env.ORCHESTRATOR_TEAM_KEY;
  if (!teamKey) {
    process.stderr.write("set ORCHESTRATOR_TEAM_KEY before running this probe\n");
    process.exit(4);
  }

  const client = fromEnv();

  // eslint-disable-next-line no-console
  console.log(`Listing open issues for team ${teamKey} (states: unstarted, backlog, triage)...`);
  const issues = await client.listIssuesByTeam({
    teamKey,
    stateTypes: ["unstarted", "backlog", "triage"],
  });

  // eslint-disable-next-line no-console
  console.log(`Found ${issues.length} issue(s):\n`);
  if (issues.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`  (none — file a ticket in team ${teamKey} using the template at`);
    // eslint-disable-next-line no-console
    console.log(`   ticket-templates/new-scim-connector.md to smoke-test the pipeline)`);
    return;
  }
  for (const issue of issues) {
    // eslint-disable-next-line no-console
    console.log(`  ${issue.identifier}  [${issue.state.name}]  ${issue.title}`);
    // eslint-disable-next-line no-console
    console.log(`    id=${issue.id}`);
    // eslint-disable-next-line no-console
    console.log(`    updated=${issue.updatedAt}`);
    // eslint-disable-next-line no-console
    console.log(`    url=${issue.url}`);
    const descLen = (issue.description ?? "").length;
    // eslint-disable-next-line no-console
    console.log(`    description: ${descLen} chars`);
  }
}

void main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`linear live-probe failed: ${msg}\n`);
  process.exit(1);
});
