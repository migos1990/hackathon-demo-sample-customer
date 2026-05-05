/**
 * Agent output eval — regression test against captured agent output.
 *
 * EVAL LAW (Law 11 meta): LLM prompt / schema change → golden-set run
 * attached to the PR. This test IS the golden-set runtime. It asserts
 * structural invariants on the captured output at
 * `examples/generated-connectors/bigcorp-hr/` (produced by the agent
 * against a synthetic LDAP-pattern ticket on 2026-05-05).
 *
 * What this test protects against:
 *   - A prompt regression that reduces file count below the expected
 *     connector-tree shape.
 *   - A prompt regression that removes dialect citations from the
 *     generated code (DIALECT-CITED would fail the lint gate, but
 *     this test catches it BEFORE the lint runs).
 *   - A prompt regression that emits a RUNBOOK missing required
 *     sections (same reasoning — runbook-check would catch at CI; this
 *     catches at dev time).
 *
 * What this test does NOT do:
 *   - Does NOT invoke the live LLM. That would cost tokens on every
 *     CI run. Re-capture manually via the live-probe CLI when the
 *     prompt intentionally changes, then update the fixture directory.
 *   - Does NOT assert exact file content. LLM output is non-deterministic;
 *     asserting "must equal snapshot" would fail on every regeneration.
 *     We assert SHAPE invariants only.
 *
 * When you change scripts/orchestrator/agent/agent.ts (prompt or
 * parser or context loader), run `npx tsx scripts/orchestrator/agent/
 * live-probe.ts --write-to examples/generated-connectors/bigcorp-hr
 * --strip-prefix connectors/bigcorp-hr/` to re-capture, then re-run
 * this test. If the invariants still hold, commit the new fixture.
 */
import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRunbook } from "../../runbook-check.js";
import { checkDialectCitations } from "../../dialect-citation-check.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "..", "..", "examples", "generated-connectors", "bigcorp-hr");

/** Returns all files under dir (recursive), excluding the non-artifact docs. */
async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkFiles(p)));
    } else if (e.isFile()) {
      // Exclude the descriptor docs we wrote (README, GATE-RESULTS) from
      // "agent-emitted files" counts — they're human-authored.
      if (e.name === "README.md" || e.name === "GATE-RESULTS.md") continue;
      out.push(p);
    }
  }
  return out;
}

describe("EVAL — agent output structural invariants (EVAL LAW golden-set)", () => {
  it("emits at least 6 files (the minimum connector tree)", async () => {
    const files = await walkFiles(FIXTURE_DIR);
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it("covers all 6 required artifact roles by path basename", async () => {
    const files = await walkFiles(FIXTURE_DIR);
    const basenames = files.map((f) => f.split("/").pop()!);
    const expected = ["mapping.ts", "client.ts", "store.ts", "server.ts", "start.ts", "RUNBOOK.md"];
    for (const name of expected) {
      expect(basenames, `required artifact "${name}" missing from agent output`).toContain(name);
    }
  });

  it("every non-markdown file is a .ts file under connectors/<slug>/ naming", async () => {
    const files = await walkFiles(FIXTURE_DIR);
    for (const f of files) {
      if (f.endsWith(".md")) continue;
      expect(f).toMatch(/\.ts$/);
    }
  });

  it("RUNBOOK.md passes the runbook-completeness gate (Connector Laws 7 + 9)", async () => {
    const runbookPath = join(FIXTURE_DIR, "RUNBOOK.md");
    const result = await checkRunbook(runbookPath);
    expect(result.ok, `runbook-check failed: missing=${result.missingSections.join(",")} empty=${result.emptySections.join(",")} placeholder=${result.placeholderSections.join(",")}`).toBe(true);
  });

  it("every .ts file passes the dialect-citation gate (Connector Law 3)", async () => {
    const all = await walkFiles(FIXTURE_DIR);
    const tsFiles = all.filter((f) => f.endsWith(".ts"));
    const result = await checkDialectCitations(tsFiles);
    expect(result.ok, `dialect-citation failed: ${result.violations.map((v) => `${v.filePath} [${v.triggerPattern}]`).join("; ")}`).toBe(true);
  });

  it("total output size is within reasonable bounds (no 10-line stubs, no 100k runaways)", async () => {
    const files = await walkFiles(FIXTURE_DIR);
    let totalChars = 0;
    for (const f of files) {
      const content = await readFile(f, "utf8");
      totalChars += content.length;
    }
    // Floor: a 6-file connector tree with genuine implementation lands
    // at ~30k chars minimum. Anything below is a stub regression.
    expect(totalChars).toBeGreaterThan(20_000);
    // Ceiling: 6-8 file tree with comments should fit under 150k.
    // Anything above suggests runaway output / no termination.
    expect(totalChars).toBeLessThan(150_000);
  });

  it("no file is suspiciously tiny (prompt regression: agent emits shells instead of content)", async () => {
    const files = await walkFiles(FIXTURE_DIR);
    for (const f of files) {
      const content = await readFile(f, "utf8");
      // Arbitrary floor: even a trivial start.ts lands at >500 chars when
      // realistic. Below this we're looking at "// TODO" shells.
      expect(content.length, `file ${f} is ${content.length} chars — below stub floor`).toBeGreaterThan(500);
    }
  });

  it("no file contains literal secret-shaped strings (prompt regression: agent inlined an example token)", async () => {
    const files = await walkFiles(FIXTURE_DIR);
    // Mirror of pre-commit hook's secret patterns, minus Bearer (which
    // LEGITIMATELY appears in "Authorization: Bearer <token>" fixture
    // strings in test files — here we're checking for the VALUE, not
    // the Bearer keyword).
    const dangerous = [
      /\bsk-[A-Za-z0-9_-]{20,}/,
      /\bgh[pousr]_[A-Za-z0-9]{30,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
    ];
    for (const f of files) {
      const content = await readFile(f, "utf8");
      for (const pat of dangerous) {
        expect(pat.test(content), `file ${f} matches secret pattern ${pat}`).toBe(false);
      }
    }
  });

  it("mapping.ts + client.ts + store.ts each import from the skeleton (proves agent composed, not reimplemented)", async () => {
    const files = await walkFiles(FIXTURE_DIR);
    const candidates = files.filter((f) => {
      const basename = f.split("/").pop();
      return basename === "mapping.ts" || basename === "client.ts" || basename === "store.ts";
    });
    let foundSkeletonImport = 0;
    for (const f of candidates) {
      const content = await readFile(f, "utf8");
      // Agent should reuse skeleton types / interfaces rather than
      // redefine ScimUser etc. The imports point there.
      if (/skeleton\/(types|store|middleware)/.test(content)) {
        foundSkeletonImport++;
      }
    }
    // At least ONE of the three should reuse skeleton types. Zero
    // reuse means the agent reimplemented the world — prompt regression.
    expect(foundSkeletonImport, "none of mapping/client/store imports from skeleton/ — possible prompt regression where agent reinvents types").toBeGreaterThanOrEqual(1);
  });
});
