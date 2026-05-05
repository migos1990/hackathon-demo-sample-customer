#!/usr/bin/env node
/**
 * SCIM compliance validator CLI.
 *
 * Usage:
 *   tsx scripts/validators/scim-compliance-cli.ts \
 *     --connector-url http://localhost:3002 \
 *     --required-ops-json '{"users_update_patch":true,"users_filter":true,...}'
 *
 * Validates the connector's /ServiceProviderConfig against the ticket's
 * required_ops block. Exit 0 on pass, non-zero with a per-violation
 * report on stderr otherwise.
 */
import { validateScimCompliance, type RequiredOps } from "./scim-compliance.js";

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function main(): void {
  const connectorUrl = arg("--connector-url");
  const requiredOpsJson = arg("--required-ops-json");
  if (!connectorUrl || !requiredOpsJson) {
    process.stderr.write(
      "usage: tsx scripts/validators/scim-compliance-cli.ts " +
        "--connector-url <url> --required-ops-json <json>\n",
    );
    process.exit(2);
  }

  let requiredOps: RequiredOps;
  try {
    requiredOps = JSON.parse(requiredOpsJson) as RequiredOps;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`failed to parse --required-ops-json: ${msg}\n`);
    process.exit(2);
  }

  validateScimCompliance({ connectorUrl, requiredOps: requiredOps! }).then((result) => {
    if (result.ok) {
      process.stdout.write(`SCIM COMPLIANCE OK: ${connectorUrl}\n`);
      process.exit(0);
    }
    process.stderr.write(`SCIM COMPLIANCE FAIL: ${connectorUrl}\n`);
    for (const v of result.violations) {
      process.stderr.write(`  [${v.check}] ${v.detail}\n`);
    }
    process.exit(1);
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scim-compliance: fatal ${msg}\n`);
    process.exit(3);
  });
}

main();
