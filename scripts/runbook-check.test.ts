import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkRunbook } from "./runbook-check.js";

const FULL_RUNBOOK = `# RUNBOOK — AcmeHR

## Environment variables

Some text here.

| Var | Purpose |
|---|---|
| X | Y |

## Deployment

Step 1. Step 2.

## Rollback

Checkout prior tag, apply.

## Smoke + verification

Run the smoke script.

## Known limitations

- Does not support groups yet.

## On-call / escalation

Primary: name@example.com.
`;

describe("checkRunbook", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "runbook-check-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes a fully-populated runbook with all six sections", async () => {
    const path = join(dir, "RUNBOOK.md");
    await writeFile(path, FULL_RUNBOOK);
    const result = await checkRunbook(path);
    expect(result.ok).toBe(true);
    expect(result.missingSections).toEqual([]);
    expect(result.emptySections).toEqual([]);
  });

  it("fails when the Environment variables section is missing", async () => {
    const broken = FULL_RUNBOOK.replace("## Environment variables", "## Totally unrelated");
    const path = join(dir, "RUNBOOK.md");
    await writeFile(path, broken);
    const result = await checkRunbook(path);
    expect(result.ok).toBe(false);
    expect(result.missingSections).toContain("env");
  });

  it("fails when the Rollback section is missing (Law 7 REVERSIBLE)", async () => {
    const broken = FULL_RUNBOOK.replace("## Rollback", "");
    const path = join(dir, "RUNBOOK.md");
    await writeFile(path, broken);
    const result = await checkRunbook(path);
    expect(result.ok).toBe(false);
    expect(result.missingSections).toContain("rollback");
  });

  it("fails when any section is empty (has heading but no content)", async () => {
    const broken = FULL_RUNBOOK.replace(
      "## Rollback\n\nCheckout prior tag, apply.",
      "## Rollback\n",
    );
    const path = join(dir, "RUNBOOK.md");
    await writeFile(path, broken);
    const result = await checkRunbook(path);
    expect(result.ok).toBe(false);
    expect(result.emptySections).toContain("rollback");
  });

  it("fails when a section has only a TBD placeholder", async () => {
    const broken = FULL_RUNBOOK.replace(
      "Checkout prior tag, apply.",
      "TBD",
    );
    const path = join(dir, "RUNBOOK.md");
    await writeFile(path, broken);
    const result = await checkRunbook(path);
    expect(result.ok).toBe(false);
    expect(result.placeholderSections).toContain("rollback");
  });

  it("accepts sections under alternate wordings (e.g. 'Env' instead of 'Environment')", async () => {
    const relaxed = FULL_RUNBOOK.replace("## Environment variables", "## Env");
    const path = join(dir, "RUNBOOK.md");
    await writeFile(path, relaxed);
    const result = await checkRunbook(path);
    expect(result.ok).toBe(true);
  });

  it("accepts h3-level sections too (markdown flexibility)", async () => {
    const h3 = FULL_RUNBOOK.replace(/^## /gm, "### ");
    const path = join(dir, "RUNBOOK.md");
    await writeFile(path, h3);
    const result = await checkRunbook(path);
    expect(result.ok).toBe(true);
  });

  it("reports multiple missing sections at once (surface all defects, not one-at-a-time)", async () => {
    const broken = FULL_RUNBOOK
      .replace("## Rollback", "## X")
      .replace("## On-call / escalation", "## Y");
    const path = join(dir, "RUNBOOK.md");
    await writeFile(path, broken);
    const result = await checkRunbook(path);
    expect(result.ok).toBe(false);
    expect(result.missingSections).toEqual(expect.arrayContaining(["rollback", "oncall"]));
  });

  it("rejects a file that doesn't exist with a clear error", async () => {
    await expect(checkRunbook(join(dir, "does-not-exist.md"))).rejects.toThrow(/ENOENT|does not exist|not found/i);
  });
});
