/**
 * Harness context loader — reads the grounding files the agent needs
 * to generate Okta-dialect-aware SCIM connectors.
 *
 * Strategy for hackathon scope: hard-code the file list per pattern.
 * Each pattern (ldap, workday, custom-db) has a fixed set of reference
 * files. Loading them all + computing a rough token estimate lets the
 * caller dispatch to sonnet vs opus based on size.
 *
 * Alternative considered: LLM-driven retrieval (agent asks for files
 * by name). Rejected for the hackathon: adds a turn, costs tokens,
 * and the pattern files are small enough that full inclusion is fine.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type PatternKey = "ldap"; // Workday + custom-db added when those patterns fill

export interface HarnessContextFile {
  path: string;
  content: string;
}

export interface HarnessContext {
  /** Pattern key (e.g. "ldap"). */
  patternKey: PatternKey;
  /** Pattern doc content (docs/patterns/*.md). */
  pattern: string;
  /** Okta-dialect doc content (docs/okta-dialect.md). */
  dialect: string;
  skeletonFiles: HarnessContextFile[];
  referenceFiles: HarnessContextFile[];
  estimatedTokens: number;
}

export interface LoadHarnessContextOptions {
  repoRoot: string;
  pattern: PatternKey;
}

const SKELETON_FILES = [
  "skeleton/types.ts",
  "skeleton/store/user-store.ts",
  "skeleton/server.ts",
  "skeleton/routes/users.ts",
  "skeleton/routes/meta.ts",
  "skeleton/middleware/auth.ts",
  "skeleton/middleware/error-envelope.ts",
];

const REFERENCE_FILES_LDAP = [
  "connectors/acme-hr/mapping.ts",
  "connectors/acme-hr/client.ts",
  "connectors/acme-hr/store.ts",
  "connectors/acme-hr/server.ts",
  "connectors/acme-hr/RUNBOOK.md",
  "demo-targets/acme-hr-lite/types.ts",
];

const PATTERN_DOC: Record<PatternKey, string> = {
  ldap: "docs/patterns/01-ldap.md",
};

const DIALECT_DOC = "docs/okta-dialect.md";

export async function loadHarnessContext(
  opts: LoadHarnessContextOptions,
): Promise<HarnessContext> {
  const patternDocPath = PATTERN_DOC[opts.pattern];
  if (!patternDocPath) {
    throw new Error(`loadHarnessContext: unknown pattern "${opts.pattern}" — supported: ${Object.keys(PATTERN_DOC).join(", ")}`);
  }

  const [dialect, pattern] = await Promise.all([
    readFileFromRoot(opts.repoRoot, DIALECT_DOC),
    readFileFromRoot(opts.repoRoot, patternDocPath),
  ]);

  const skeletonFiles = await Promise.all(
    SKELETON_FILES.map(async (p) => ({
      path: p,
      content: await readFileFromRoot(opts.repoRoot, p),
    })),
  );

  const referencePaths = opts.pattern === "ldap" ? REFERENCE_FILES_LDAP : [];
  const referenceFiles = await Promise.all(
    referencePaths.map(async (p) => ({
      path: p,
      content: await readFileFromRoot(opts.repoRoot, p),
    })),
  );

  const totalChars =
    dialect.length +
    pattern.length +
    skeletonFiles.reduce((s, f) => s + f.content.length, 0) +
    referenceFiles.reduce((s, f) => s + f.content.length, 0);

  // Rough token estimate: ~4 chars/token for English + code.
  const estimatedTokens = Math.ceil(totalChars / 4);

  return {
    patternKey: opts.pattern,
    pattern,
    dialect,
    skeletonFiles,
    referenceFiles,
    estimatedTokens,
  };
}

async function readFileFromRoot(root: string, relPath: string): Promise<string> {
  return readFile(join(root, relPath), "utf8");
}
