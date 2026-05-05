/**
 * CLI integration test — spawns the actual tsx runner and exercises
 * the sign + verify subcommands through stdin/stdout/exit code. No in-
 * process shortcuts. This is what the demo pipes into jq on beat 9.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromotionManifest, SignedPromotionManifest } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "cli.ts");

const GOOD_KEY = "a".repeat(64);
const WRONG_KEY = "b".repeat(64);

const MANIFEST: PromotionManifest = {
  manifest_version: 1,
  customer_slug: "acme-hr",
  ticket_id: "LIN-1234",
  git_commit: "b494811abcdef0123456789abcdef0123456789a",
  git_tag: "v1.0.0-acme-hr",
  preprod_tenant: "demo-customer-a-staging.oktapreview.com",
  prod_tenant: "demo-customer-a-prod.okta.com",
  terraform_module_version: "0.3.1",
  fixtures_hash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  preprod_verify: {
    ran_at: "2026-05-05T14:00:00Z",
    tsc_clean: true,
    vitest_passed: "168/168",
    oin_spec_tests_passed: "12/12",
    tf_plan_empty: true,
    smoke_test_passed: true,
    log_errors_count: 0,
  },
  approver_github_username: "lmigault",
  approved_at: "2026-05-05T14:05:00Z",
};

// Resolve tsx binary from node_modules directly — avoids whatever npx shim
// the local environment routes through (some dev machines route npx via
// an Artifactory proxy that blocks spawn). node_modules/.bin/tsx is always
// present after install.
const TSX_BIN = join(__dirname, "..", "..", "node_modules", ".bin", "tsx");

function runCli(args: string[], input: string, env: Record<string, string> = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(TSX_BIN, [CLI_PATH, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("promotion-manifest CLI", () => {
  describe("sign", () => {
    it("reads manifest from stdin, writes signed envelope to stdout, exit 0", () => {
      const { status, stdout } = runCli(["sign"], JSON.stringify(MANIFEST), {
        PROMOTION_SIGNING_KEY_CURRENT: GOOD_KEY,
        PROMOTION_SIGNING_KEY_CURRENT_ID: "current",
      });
      expect(status).toBe(0);
      const signed = JSON.parse(stdout) as SignedPromotionManifest;
      expect(signed.manifest).toEqual(MANIFEST);
      expect(signed.key_id).toBe("current");
      expect(signed.signature).toMatch(/^[a-f0-9]{64}$/);
    });

    it("exits non-zero when PROMOTION_SIGNING_KEY_CURRENT is missing", () => {
      const { status, stderr } = runCli(["sign"], JSON.stringify(MANIFEST), {
        PROMOTION_SIGNING_KEY_CURRENT: "",
      });
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/PROMOTION_SIGNING_KEY_CURRENT/);
    });

    it("exits non-zero on malformed JSON stdin", () => {
      const { status, stderr } = runCli(["sign"], "not json", {
        PROMOTION_SIGNING_KEY_CURRENT: GOOD_KEY,
        PROMOTION_SIGNING_KEY_CURRENT_ID: "current",
      });
      expect(status).not.toBe(0);
      expect(stderr.toLowerCase()).toMatch(/json|parse/);
    });
  });

  describe("verify", () => {
    it("exits 0 when the signed manifest verifies against current key", () => {
      const signRes = runCli(["sign"], JSON.stringify(MANIFEST), {
        PROMOTION_SIGNING_KEY_CURRENT: GOOD_KEY,
        PROMOTION_SIGNING_KEY_CURRENT_ID: "current",
      });
      const { status, stderr } = runCli(["verify"], signRes.stdout, {
        PROMOTION_SIGNING_KEY_CURRENT: GOOD_KEY,
        PROMOTION_SIGNING_KEY_CURRENT_ID: "current",
      });
      expect(status).toBe(0);
      expect(stderr.toLowerCase()).toMatch(/valid|ok|verified/);
    });

    it("exits non-zero when signature is from a key the verifier doesn't hold", () => {
      const signRes = runCli(["sign"], JSON.stringify(MANIFEST), {
        PROMOTION_SIGNING_KEY_CURRENT: WRONG_KEY,
        PROMOTION_SIGNING_KEY_CURRENT_ID: "adversary",
      });
      const { status, stderr } = runCli(["verify"], signRes.stdout, {
        PROMOTION_SIGNING_KEY_CURRENT: GOOD_KEY,
        PROMOTION_SIGNING_KEY_CURRENT_ID: "current",
      });
      expect(status).not.toBe(0);
      expect(stderr.toLowerCase()).toMatch(/invalid|fail/);
    });

    it("accepts rotation — signed with previous key, verified with current+previous", () => {
      const signRes = runCli(["sign"], JSON.stringify(MANIFEST), {
        PROMOTION_SIGNING_KEY_CURRENT: WRONG_KEY,
        PROMOTION_SIGNING_KEY_CURRENT_ID: "previous",
      });
      const { status } = runCli(["verify"], signRes.stdout, {
        PROMOTION_SIGNING_KEY_CURRENT: GOOD_KEY,
        PROMOTION_SIGNING_KEY_CURRENT_ID: "current",
        PROMOTION_SIGNING_KEY_PREVIOUS: WRONG_KEY,
        PROMOTION_SIGNING_KEY_PREVIOUS_ID: "previous",
      });
      expect(status).toBe(0);
    });
  });

  describe("unknown subcommand", () => {
    it("exits non-zero and prints usage", () => {
      const { status, stderr } = runCli(["oopsie"], "");
      expect(status).not.toBe(0);
      expect(stderr.toLowerCase()).toMatch(/usage|unknown|sign|verify/);
    });
  });
});
