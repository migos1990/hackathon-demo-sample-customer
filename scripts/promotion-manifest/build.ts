/**
 * Build a PromotionManifest from pipeline inputs + compute fixtures_hash
 * over a directory tree.
 *
 * Build-time refuses non-green gates: tsc_clean === false, vitest not N/N,
 * oin_spec_tests_passed not N/N, log_errors_count > 0. These are the same
 * conditions the pre-prod verify gate asserts per docs/promotion-flow.md §3.
 * Refusing at manifest-build time is a defense-in-depth check — the gate
 * itself should already have stopped promotion, but if a buggy gate ever
 * let something slip through, the manifest builder catches it before
 * signing anything that would imply "this passed".
 *
 * hashFixtures is directory-tree SHA-256:
 *   1. Walk tree, collect [relative-path, sha256(contents)] pairs.
 *   2. Sort by relative-path (byte-wise).
 *   3. Hash the concatenation of "path\0hash\0" tuples.
 * Sorting removes filesystem-enumeration-order variance. The trailing
 * null-byte separators make path-vs-hash injection impossible (a file
 * named with a null byte can't collide with a sibling's hash).
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { PreprodVerify, PromotionManifest } from "./types.js";

export interface BuildManifestInputs {
  customer_slug: string;
  ticket_id: string;
  git_commit: string;
  git_tag: string;
  preprod_tenant: string;
  prod_tenant: string;
  terraform_module_version: string;
  fixtures_hash: string;
  preprod_verify: PreprodVerify;
  approver_github_username: string;
  /** Optional override; defaults to now(). Useful for replaying manifests. */
  approved_at?: string;
}

export function buildManifest(inputs: BuildManifestInputs): PromotionManifest {
  assertVerifyPassed(inputs.preprod_verify);

  return {
    manifest_version: 1,
    customer_slug: inputs.customer_slug,
    ticket_id: inputs.ticket_id,
    git_commit: inputs.git_commit,
    git_tag: inputs.git_tag,
    preprod_tenant: inputs.preprod_tenant,
    prod_tenant: inputs.prod_tenant,
    terraform_module_version: inputs.terraform_module_version,
    fixtures_hash: inputs.fixtures_hash,
    preprod_verify: inputs.preprod_verify,
    approver_github_username: inputs.approver_github_username,
    approved_at: inputs.approved_at ?? new Date().toISOString(),
  };
}

function assertVerifyPassed(v: PreprodVerify): void {
  if (!v.tsc_clean) {
    throw new Error("pre-prod verify gate failed: tsc not clean");
  }
  if (!isAllPassed(v.vitest_passed)) {
    throw new Error(`pre-prod verify gate failed: vitest ${v.vitest_passed}`);
  }
  if (!isAllPassed(v.oin_spec_tests_passed)) {
    throw new Error(`pre-prod verify gate failed: OIN SPEC tests ${v.oin_spec_tests_passed}`);
  }
  if (!v.tf_plan_empty) {
    throw new Error("pre-prod verify gate failed: terraform plan not empty");
  }
  if (!v.smoke_test_passed) {
    throw new Error("pre-prod verify gate failed: smoke test did not pass");
  }
  if (v.log_errors_count > 0) {
    throw new Error(`pre-prod verify gate failed: ${v.log_errors_count} log errors in smoke window`);
  }
}

/** Returns true for "N/N" with N > 0. "0/0" and mismatched counts fail. */
function isAllPassed(s: string): boolean {
  const match = /^(\d+)\/(\d+)$/.exec(s);
  if (!match) return false;
  const passed = Number.parseInt(match[1]!, 10);
  const total = Number.parseInt(match[2]!, 10);
  return total > 0 && passed === total;
}

export async function hashFixtures(dirPath: string): Promise<string> {
  const entries = await collectFiles(dirPath, dirPath);
  // Sort by relative path for deterministic, filesystem-enumeration-
  // order-independent output.
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const rootHash = createHash("sha256");
  for (const entry of entries) {
    rootHash.update(entry.relPath, "utf8");
    rootHash.update("\0", "utf8");
    rootHash.update(entry.contentHash, "hex");
    rootHash.update("\0", "utf8");
  }
  return rootHash.digest("hex");
}

interface FileEntry {
  relPath: string;
  contentHash: string;
}

async function collectFiles(root: string, current: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(root, full)));
    } else if (entry.isFile()) {
      const contents = await readFile(full);
      const contentHash = createHash("sha256").update(contents).digest("hex");
      out.push({ relPath: relative(root, full), contentHash });
    }
    // Symlinks and other types: skip. Fixtures should be regular files.
  }
  return out;
}
