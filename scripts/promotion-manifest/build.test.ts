import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildManifest, hashFixtures } from "./build.js";
import type { PreprodVerify } from "./types.js";

const VERIFY_PASS: PreprodVerify = {
  ran_at: "2026-05-05T14:00:00Z",
  tsc_clean: true,
  vitest_passed: "156/156",
  oin_spec_tests_passed: "12/12",
  tf_plan_empty: true,
  smoke_test_passed: true,
  log_errors_count: 0,
};

describe("buildManifest", () => {
  it("composes a PromotionManifest from literal inputs with approved_at stamped now", () => {
    const before = Date.now();
    const manifest = buildManifest({
      customer_slug: "acme-hr",
      ticket_id: "LIN-1234",
      git_commit: "b7c15c9abcdef0123456789abcdef0123456789a",
      git_tag: "v1.0.0-acme-hr",
      preprod_tenant: "demo-customer-a-staging.oktapreview.com",
      prod_tenant: "demo-customer-a-prod.okta.com",
      terraform_module_version: "0.3.1",
      fixtures_hash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      preprod_verify: VERIFY_PASS,
      approver_github_username: "lmigault",
    });
    const after = Date.now();

    expect(manifest.manifest_version).toBe(1);
    expect(manifest.customer_slug).toBe("acme-hr");
    expect(manifest.approver_github_username).toBe("lmigault");
    const approvedMs = new Date(manifest.approved_at).getTime();
    expect(approvedMs).toBeGreaterThanOrEqual(before);
    expect(approvedMs).toBeLessThanOrEqual(after);
  });

  it("accepts an explicit approved_at override (for replaying or backdated manifests)", () => {
    const manifest = buildManifest({
      customer_slug: "acme-hr",
      ticket_id: "LIN-1234",
      git_commit: "abc123",
      git_tag: "v1",
      preprod_tenant: "x.oktapreview.com",
      prod_tenant: "y.okta.com",
      terraform_module_version: "0.1.0",
      fixtures_hash: "a".repeat(64),
      preprod_verify: VERIFY_PASS,
      approver_github_username: "lmigault",
      approved_at: "2026-05-05T14:05:00Z",
    });
    expect(manifest.approved_at).toBe("2026-05-05T14:05:00Z");
  });

  it("refuses to build when preprod_verify shows a failed gate", () => {
    expect(() =>
      buildManifest({
        customer_slug: "acme-hr",
        ticket_id: "LIN-1234",
        git_commit: "abc",
        git_tag: "v1",
        preprod_tenant: "x.oktapreview.com",
        prod_tenant: "y.okta.com",
        terraform_module_version: "0.1.0",
        fixtures_hash: "a".repeat(64),
        preprod_verify: { ...VERIFY_PASS, tsc_clean: false },
        approver_github_username: "lmigault",
      }),
    ).toThrow(/pre-prod|gate|failed/i);
  });

  it("refuses to build when vitest_passed shows any failures (e.g. '155/156')", () => {
    expect(() =>
      buildManifest({
        customer_slug: "acme-hr",
        ticket_id: "LIN-1234",
        git_commit: "abc",
        git_tag: "v1",
        preprod_tenant: "x.oktapreview.com",
        prod_tenant: "y.okta.com",
        terraform_module_version: "0.1.0",
        fixtures_hash: "a".repeat(64),
        preprod_verify: { ...VERIFY_PASS, vitest_passed: "155/156" },
        approver_github_username: "lmigault",
      }),
    ).toThrow(/vitest|test|failed/i);
  });

  it("refuses to build when OIN SPEC Tests are not 12/12", () => {
    expect(() =>
      buildManifest({
        customer_slug: "acme-hr",
        ticket_id: "LIN-1234",
        git_commit: "abc",
        git_tag: "v1",
        preprod_tenant: "x.oktapreview.com",
        prod_tenant: "y.okta.com",
        terraform_module_version: "0.1.0",
        fixtures_hash: "a".repeat(64),
        preprod_verify: { ...VERIFY_PASS, oin_spec_tests_passed: "11/12" },
        approver_github_username: "lmigault",
      }),
    ).toThrow(/OIN/);
  });

  it("refuses to build when log_errors_count > 0 (smoke window had errors)", () => {
    expect(() =>
      buildManifest({
        customer_slug: "acme-hr",
        ticket_id: "LIN-1234",
        git_commit: "abc",
        git_tag: "v1",
        preprod_tenant: "x.oktapreview.com",
        prod_tenant: "y.okta.com",
        terraform_module_version: "0.1.0",
        fixtures_hash: "a".repeat(64),
        preprod_verify: { ...VERIFY_PASS, log_errors_count: 1 },
        approver_github_username: "lmigault",
      }),
    ).toThrow(/log|error/i);
  });
});

describe("hashFixtures", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fixtures-hash-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("produces a 64-char hex SHA-256", async () => {
    await writeFile(join(dir, "a.json"), "{}");
    const hash = await hashFixtures(dir);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic — same tree → same hash", async () => {
    await writeFile(join(dir, "a.json"), "{}");
    await writeFile(join(dir, "b.json"), `{"x":1}`);
    const h1 = await hashFixtures(dir);
    const h2 = await hashFixtures(dir);
    expect(h1).toBe(h2);
  });

  it("is order-independent — filesystem enumeration order doesn't affect the hash", async () => {
    // Write files in different orders across two dirs with identical contents.
    const dir2 = await mkdtemp(join(tmpdir(), "fixtures-hash-"));
    try {
      await writeFile(join(dir, "a.json"), "1");
      await writeFile(join(dir, "b.json"), "2");
      await writeFile(join(dir2, "b.json"), "2");
      await writeFile(join(dir2, "a.json"), "1");
      expect(await hashFixtures(dir)).toBe(await hashFixtures(dir2));
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it("changes when any file's content changes", async () => {
    await writeFile(join(dir, "a.json"), "1");
    const h1 = await hashFixtures(dir);
    await writeFile(join(dir, "a.json"), "2");
    const h2 = await hashFixtures(dir);
    expect(h1).not.toBe(h2);
  });

  it("changes when a file is added", async () => {
    await writeFile(join(dir, "a.json"), "1");
    const h1 = await hashFixtures(dir);
    await writeFile(join(dir, "b.json"), "2");
    const h2 = await hashFixtures(dir);
    expect(h1).not.toBe(h2);
  });

  it("recurses into subdirectories", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "nested.json"), "1");
    const h1 = await hashFixtures(dir);
    await writeFile(join(dir, "sub", "nested.json"), "2");
    const h2 = await hashFixtures(dir);
    expect(h1).not.toBe(h2);
  });
});
