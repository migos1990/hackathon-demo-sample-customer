#!/usr/bin/env node
/**
 * Runbook check CLI.
 *
 * Usage:
 *   tsx scripts/runbook-check-cli.ts <path-to-RUNBOOK.md>
 *   tsx scripts/runbook-check-cli.ts connectors/acme-hr/RUNBOOK.md
 *
 * Exit 0 on pass, non-zero with a human-readable report on stderr
 * otherwise. Used by the pre-commit hook to gate connector merges.
 */
import { checkRunbook } from "./runbook-check.js";

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("usage: tsx scripts/runbook-check-cli.ts <path-to-RUNBOOK.md>\n");
    process.exit(2);
  }

  try {
    const result = await checkRunbook(path);
    if (result.ok) {
      process.stdout.write(`RUNBOOK OK: ${path}\n`);
      process.exit(0);
    }

    process.stderr.write(`RUNBOOK FAIL: ${path}\n`);
    if (result.missingSections.length > 0) {
      process.stderr.write(`  missing sections:     ${result.missingSections.join(", ")}\n`);
    }
    if (result.emptySections.length > 0) {
      process.stderr.write(`  empty sections:       ${result.emptySections.join(", ")}\n`);
    }
    if (result.placeholderSections.length > 0) {
      process.stderr.write(`  TBD/placeholder only: ${result.placeholderSections.join(", ")}\n`);
    }
    process.stderr.write("  Connector Laws 7 (REVERSIBLE) + 9 (RUNBOOK-COMPLETE) — see docs/connector-laws.md\n");
    process.exit(1);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`RUNBOOK CHECK ERROR: ${msg}\n`);
    process.exit(3);
  }
}

void main();
