/**
 * Harness context loader tests — loads the grounding files the agent
 * reads to produce Okta-dialect-aware connectors.
 */
import { describe, it, expect } from "vitest";
import { loadHarnessContext } from "./harness-context.js";
import { join } from "node:path";

describe("loadHarnessContext", () => {
  const repoRoot = join(__dirname, "..", "..", "..");

  it("loads all grounding docs for the LDAP pattern", async () => {
    const ctx = await loadHarnessContext({ repoRoot, pattern: "ldap" });
    expect(ctx.dialect).toBeDefined();
    expect(ctx.dialect.length).toBeGreaterThan(100);
    expect(ctx.pattern).toBeDefined();
    expect(ctx.pattern.length).toBeGreaterThan(100);
    expect(ctx.skeletonFiles.length).toBeGreaterThan(0);
    expect(ctx.referenceFiles.length).toBeGreaterThan(0);
  });

  it("dialect doc contains the PATCH active:false section", async () => {
    const ctx = await loadHarnessContext({ repoRoot, pattern: "ldap" });
    expect(ctx.dialect).toMatch(/PATCH|active|deprovision/i);
  });

  it("pattern doc contains the source-schema shape for LDAP", async () => {
    const ctx = await loadHarnessContext({ repoRoot, pattern: "ldap" });
    expect(ctx.pattern).toMatch(/uid|cn|sn|mail|memberOf/);
  });

  it("skeleton files include the UserStore interface + types", async () => {
    const ctx = await loadHarnessContext({ repoRoot, pattern: "ldap" });
    const all = ctx.skeletonFiles.map((f) => f.content).join("\n");
    expect(all).toMatch(/interface UserStore/);
    expect(all).toMatch(/ScimUser|StoredUser/);
  });

  it("reference files include mapping.ts, store.ts, client.ts, server.ts from acme-hr", async () => {
    const ctx = await loadHarnessContext({ repoRoot, pattern: "ldap" });
    const paths = ctx.referenceFiles.map((f) => f.path);
    expect(paths.some((p) => p.endsWith("mapping.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("store.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("client.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("server.ts"))).toBe(true);
  });

  it("reports total context size in tokens (rough estimate)", async () => {
    const ctx = await loadHarnessContext({ repoRoot, pattern: "ldap" });
    expect(ctx.estimatedTokens).toBeGreaterThan(1000);
    // Reasonable upper bound — we don't want to blow 200k context
    expect(ctx.estimatedTokens).toBeLessThan(150_000);
  });

  it("rejects an unknown pattern with a helpful error", async () => {
    await expect(
      loadHarnessContext({ repoRoot, pattern: "unknown-pattern" as "ldap" }),
    ).rejects.toThrow(/pattern|unknown/i);
  });
});
