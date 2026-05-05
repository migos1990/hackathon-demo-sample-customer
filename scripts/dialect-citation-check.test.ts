import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkDialectCitations } from "./dialect-citation-check.js";

describe("checkDialectCitations", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dialect-citation-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes a file that has a dialect trigger AND a citation in the same file", async () => {
    const path = join(dir, "a.ts");
    await writeFile(
      path,
      `// RFC 7644 §3.5.2 is the authority for PATCH semantics.
export const CT = "application/scim+json";`,
    );
    const result = await checkDialectCitations([path]);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("fails a file that has a dialect trigger but NO citation", async () => {
    const path = join(dir, "a.ts");
    await writeFile(path, `export const CT = "application/scim+json";`);
    const result = await checkDialectCitations([path]);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.filePath).toBe(path);
    expect(result.violations[0]?.triggerPattern).toMatch(/scim\\?\+?json/);
  });

  it("passes a file that cites docs/okta-dialect.md", async () => {
    const path = join(dir, "a.ts");
    await writeFile(
      path,
      `// See docs/okta-dialect.md#2 for the case-sensitivity override.
export const f = 'userName eq "x"';`,
    );
    const result = await checkDialectCitations([path]);
    expect(result.ok).toBe(true);
  });

  it("passes a file that cites developer.okta.com", async () => {
    const path = join(dir, "a.ts");
    await writeFile(
      path,
      `// Per https://developer.okta.com/docs/concepts/scim/ the user id is opaque.
export const ID_PREFIX = "00u";`,
    );
    const result = await checkDialectCitations([path]);
    expect(result.ok).toBe(true);
  });

  it("passes a file that uses UNVERIFIED as an explicit escape hatch", async () => {
    const path = join(dir, "a.ts");
    await writeFile(
      path,
      `// UNVERIFIED: content-type choice pending customer confirmation.
export const CT = "application/scim+json";`,
    );
    const result = await checkDialectCitations([path]);
    expect(result.ok).toBe(true);
  });

  it("skips test files entirely — tests legitimately reference triggers as fixtures", async () => {
    const path = join(dir, "foo.test.ts");
    await writeFile(
      path,
      `// No citation needed — this is a test file.
const ct = "application/scim+json";
const filter = 'userName eq "jdoe"';`,
    );
    const result = await checkDialectCitations([path]);
    expect(result.ok).toBe(true);
  });

  it("skips non-ts files", async () => {
    const path = join(dir, "a.json");
    await writeFile(path, `{"ct": "application/scim+json"}`);
    const result = await checkDialectCitations([path]);
    expect(result.ok).toBe(true);
  });

  it("reports multiple violations across multiple files", async () => {
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    await writeFile(a, `export const CT = "application/scim+json";`);
    await writeFile(b, `import "scim-patch"; // no citation anywhere`);
    const result = await checkDialectCitations([a, b]);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((v) => v.filePath).sort()).toEqual([a, b].sort());
  });

  it("treats a scim2-parse-filter import as a trigger requiring citation", async () => {
    const path = join(dir, "a.ts");
    await writeFile(
      path,
      `import { parse } from "scim2-parse-filter";
export const x = 1;`,
    );
    const result = await checkDialectCitations([path]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.triggerPattern).toMatch(/scim2-parse-filter/);
  });

  it("accepts RFC 7643 as a citation (core schema), not only 7644 (protocol)", async () => {
    const path = join(dir, "a.ts");
    await writeFile(
      path,
      `// Per RFC 7643 §4.1.1 active is optional and assumed true.
const IS_ACTIVE_DEFAULT = true;
export const f = 'userName eq "x"';`,
    );
    const result = await checkDialectCitations([path]);
    expect(result.ok).toBe(true);
  });

  it("does not crash on a file that has neither trigger nor citation", async () => {
    const path = join(dir, "a.ts");
    await writeFile(path, `export const x = 1 + 2;`);
    const result = await checkDialectCitations([path]);
    expect(result.ok).toBe(true);
  });

  it("skips files that do not exist (e.g. deleted-then-staged), does not throw", async () => {
    const result = await checkDialectCitations([join(dir, "ghost.ts")]);
    expect(result.ok).toBe(true);
  });
});
