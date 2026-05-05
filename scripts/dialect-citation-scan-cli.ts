#!/usr/bin/env node
/**
 * Dialect-citation scan CLI.
 *
 * Usage:
 *   tsx scripts/dialect-citation-scan-cli.ts <file1.ts> [file2.ts ...]
 *
 * Scans the given files for Okta-dialect trigger patterns that need
 * citations (per docs/connector-laws.md §3 DIALECT-CITED). Exit 0 on
 * pass, non-zero with a report on stderr otherwise.
 *
 * Used by the pre-commit hook to gate skeleton/ + connectors/ staged
 * .ts files (non-test). Test files are filtered before this script
 * is invoked.
 */
import { checkDialectCitations } from "./dialect-citation-check.js";

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stderr.write("usage: tsx scripts/dialect-citation-scan-cli.ts <file.ts> [...]\n");
    process.exit(2);
  }

  const result = await checkDialectCitations(files);
  if (result.ok) {
    process.stdout.write(`DIALECT OK: ${files.length} file(s) scanned\n`);
    process.exit(0);
  }

  process.stderr.write("DIALECT FAIL — these files touch Okta-specific behavior without citation:\n");
  for (const v of result.violations) {
    process.stderr.write(`  ${v.filePath}\n`);
    process.stderr.write(`    trigger: ${v.triggerPattern}\n`);
  }
  process.stderr.write(
    "\n  Add one of:\n" +
      "    - A comment referencing docs/okta-dialect.md#<section>\n" +
      "    - A citation of RFC 7643 or RFC 7644 with section\n" +
      "    - An Okta official-doc URL (developer.okta.com, help.okta.com)\n" +
      "    - An explicit // UNVERIFIED: <justification>\n" +
      "\n  See docs/connector-laws.md §3 DIALECT-CITED.\n",
  );
  process.exit(1);
}

void main();
