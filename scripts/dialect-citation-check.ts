/**
 * Dialect-citation linter — closes Connector Law 3 (DIALECT-CITED).
 *
 * When a source file under skeleton/ or connectors/ touches an Okta-specific
 * behavior (SCIM content type, OIN case-sensitive userName, Okta-shaped id,
 * scim-patch semantics, scim2-parse-filter semantics), the file MUST cite
 * the authoritative source — either docs/okta-dialect.md, an RFC 7643/7644
 * reference, an Okta official-doc URL, or an explicit UNVERIFIED annotation.
 *
 * Design:
 *   - Test files (*.test.ts) are skipped — they legitimately reference
 *     triggers as fixtures without needing citations.
 *   - Non-.ts files are skipped.
 *   - File-level check, not line-level: the citation may be anywhere in the
 *     same file. This is coarse by design — pinning citations to specific
 *     code sites is impractical and the goal is traceability, not line-
 *     precise annotation.
 *   - Only the FIRST triggered pattern is reported per file (reduces noise
 *     when multiple patterns hit; fixing any one citation covers all).
 */
import { readFile } from "node:fs/promises";

export interface DialectViolation {
  filePath: string;
  triggerPattern: string;
}

export interface DialectCheckResult {
  ok: boolean;
  violations: DialectViolation[];
}

/**
 * Patterns that trigger the citation requirement. The `key` is the
 * human-readable label surfaced in violation reports; the `pattern` is
 * the regex scanned against file contents.
 *
 * Keep this list SHORT — every trigger generates noise if over-broad.
 * Six patterns cover ~90% of dialect-sensitive code in this repo.
 */
const DIALECT_TRIGGERS: Array<{ key: string; pattern: RegExp }> = [
  { key: "application/scim+json", pattern: /application\/scim\+json/ },
  { key: "userName eq", pattern: /userName['"`\s]*eq/ },
  { key: "00u Okta-shaped id", pattern: /["'`]00u['"`]/ },
  // Quoted module name catches all import forms: `from "..."`, `require("...")`,
  // bare side-effect `import "..."`, and dynamic `import("...")`.
  { key: 'import "scim-patch"', pattern: /["']scim-patch["']/ },
  { key: 'import "scim2-parse-filter"', pattern: /["']scim2-parse-filter["']/ },
  { key: "scimType uniqueness", pattern: /scimType["'`\s]*[:=]\s*["'`]uniqueness["'`]/ },
];

/**
 * Patterns that satisfy the citation requirement. Any one occurrence of
 * any of these anywhere in the file is sufficient.
 */
const CITATION_PATTERNS: RegExp[] = [
  /okta-dialect\.md/,
  /RFC\s*7643/i,
  /RFC\s*7644/i,
  /developer\.okta\.com/,
  /help\.okta\.com/,
  /trust\.okta\.com/,
  /\bUNVERIFIED\b/,
];

export async function checkDialectCitations(
  filePaths: readonly string[],
): Promise<DialectCheckResult> {
  const violations: DialectViolation[] = [];

  for (const filePath of filePaths) {
    if (!filePath.endsWith(".ts")) continue;
    if (filePath.endsWith(".test.ts")) continue;

    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (err) {
      // Staged-then-deleted files get an ENOENT here. That's fine — they
      // won't contribute a violation. Skip quietly.
      if (isNoEntError(err)) continue;
      throw err;
    }

    const trigger = DIALECT_TRIGGERS.find((t) => t.pattern.test(content));
    if (!trigger) continue;

    const hasCitation = CITATION_PATTERNS.some((p) => p.test(content));
    if (hasCitation) continue;

    violations.push({ filePath, triggerPattern: trigger.key });
  }

  return { ok: violations.length === 0, violations };
}

function isNoEntError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT";
}
