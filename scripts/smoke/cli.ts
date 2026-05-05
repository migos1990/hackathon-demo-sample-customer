#!/usr/bin/env node
/**
 * Smoke-runner CLI. Thin wrapper around runSmoke for CI + demo scripts.
 *
 * Usage:
 *   tsx scripts/smoke/cli.ts \
 *     --connector-url http://localhost:3002 \
 *     --target-url    http://localhost:4001
 *
 * Writes the SmokeReport JSON to stdout. Exits 0 on smoke_test_passed,
 * non-zero otherwise. The stdout JSON is the input to buildManifest's
 * preprod_verify.smoke_test_passed + log_errors_count fields.
 */
import { runSmoke } from "./run-smoke.js";

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function main(): void {
  const connectorUrl = arg("--connector-url");
  const targetUrl = arg("--target-url");
  if (!connectorUrl || !targetUrl) {
    process.stderr.write(
      "usage: tsx scripts/smoke/cli.ts --connector-url <url> --target-url <url>\n",
    );
    process.exit(2);
  }

  const connectorAuthToken = process.env.SCIM_AUTH_TOKEN;
  const targetAuthToken = process.env.ACME_HR_API_TOKEN;

  runSmoke({
    connectorUrl,
    targetUrl,
    ...(connectorAuthToken !== undefined && connectorAuthToken !== "" && { connectorAuthToken }),
    ...(targetAuthToken !== undefined && targetAuthToken !== "" && { targetAuthToken }),
  }).then((report) => {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exit(report.smoke_test_passed ? 0 : 1);
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`smoke: fatal ${msg}\n`);
    process.exit(3);
  });
}

main();
