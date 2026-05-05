#!/usr/bin/env node
/**
 * Live probe: runs the real agent against the real LiteLLM endpoint
 * with a minimal synthetic LDAP-pattern ticket. Prints the generated
 * file list (paths + sizes) to stdout.
 *
 * Usage:
 *   eval "$(grep -E '^ANTHROPIC_' .env | sed 's/^/export /')"
 *   tsx scripts/orchestrator/agent/live-probe.ts
 *   tsx scripts/orchestrator/agent/live-probe.ts \
 *     --write-to examples/generated-connectors/bigcorp-hr
 *
 * With --write-to, each generated file is persisted to disk under the
 * given output directory, preserving the relative path. Used to
 * capture demo-day evidence of the agent's output for the submission.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { fromEnv as llmFromEnv } from "../../llm/anthropic-client.js";
import { createAgent } from "./agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

async function main(): Promise<void> {
  const writeTo = flag("--write-to");

  const llm = llmFromEnv();
  const agent = createAgent({ repoRoot: REPO_ROOT, llm });

  const ticket = {
    customer_app_name: "BigCorpHR",
    customer_slug: "bigcorp-hr",
    auth_method: "bearer",
    auth_credential_env_var: "BIGCORP_HR_API_TOKEN",
    base_url: "https://api.bigcorp-hr.example.com",
    user_model_source: "ldap",
    lifecycle_policy: "soft_delete",
    target_okta_tenant: "demo-customer-a-staging.oktapreview.com",
    terraform_workspace: "staging",
    required_ops: {
      users_create: true,
      users_read: true,
      users_update_patch: true,
      users_delete: true,
      users_list: true,
      users_filter: true,
    },
  };

  // eslint-disable-next-line no-console
  console.log(`Invoking agent for ticket ${ticket.customer_slug}...`);
  const start = Date.now();
  const files = await agent.generateConnector({
    ticket,
    ticketIdentifier: "SCIM-LIVE-PROBE",
  });
  const durationMs = Date.now() - start;

  // eslint-disable-next-line no-console
  console.log(`\n✓ Agent produced ${files.length} file(s) in ${durationMs}ms:\n`);
  for (const f of files) {
    const lines = f.content.split("\n").length;
    // eslint-disable-next-line no-console
    console.log(`  ${f.path}`.padEnd(60) + `${lines.toString().padStart(4)} lines  ${f.content.length.toString().padStart(6)} chars`);
    // eslint-disable-next-line no-console
    console.log(`    message: ${f.message}`);
  }

  if (writeTo !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`\nWriting ${files.length} file(s) to ${writeTo}/`);
    const base = flag("--strip-prefix");
    for (const f of files) {
      // Agent emits paths like "connectors/bigcorp-hr/store.ts".
      // --strip-prefix lets us strip "connectors/bigcorp-hr/" so the
      // files land flat under --write-to.
      let relPath = f.path;
      if (base && relPath.startsWith(base)) relPath = relPath.slice(base.length).replace(/^\/+/, "");
      const absPath = join(writeTo, relPath);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, f.content, "utf8");
      // eslint-disable-next-line no-console
      console.log(`  ✓ ${absPath}`);
    }
  }
}

void main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`agent live-probe failed: ${msg}\n`);
  process.exit(1);
});
