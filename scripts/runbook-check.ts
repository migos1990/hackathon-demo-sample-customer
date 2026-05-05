/**
 * Runbook-completeness checker.
 *
 * Closes Connector Laws 7 (REVERSIBLE) and 9 (RUNBOOK-COMPLETE) per
 * docs/connector-laws.md. Every generated connector ships a RUNBOOK.md
 * at its root; this tool verifies the six required sections are present,
 * non-empty, and not stubbed with "TBD".
 *
 * Section matching is tolerant of alternate wordings (see REQUIRED_SECTIONS)
 * but strict about presence. "We intended to fill this in" is the exact
 * failure mode the law exists to prevent.
 */
import { readFile } from "node:fs/promises";

export interface RunbookCheckResult {
  ok: boolean;
  /** Section keys that have no matching heading in the file. */
  missingSections: string[];
  /** Section keys whose heading exists but has no content below it. */
  emptySections: string[];
  /** Section keys whose only content is a placeholder like "TBD". */
  placeholderSections: string[];
}

/**
 * The six required sections (Connector Laws 7 + 9). Each entry has a
 * canonical key (used in error reports) and a list of regex patterns
 * that tolerate alternate wordings in the actual heading text.
 */
const REQUIRED_SECTIONS: Array<{ key: string; patterns: RegExp[] }> = [
  { key: "env", patterns: [/\benv(?:ironment)?\b/i, /\bvariables\b/i] },
  { key: "deploy", patterns: [/\bdeploy(?:ment)?\b/i] },
  { key: "rollback", patterns: [/\brollback\b/i, /\brevert\b/i] },
  { key: "smoke", patterns: [/\bsmoke\b/i, /\bverification\b/i, /\bpost-deploy\b/i] },
  { key: "limitations", patterns: [/\blimitations?\b/i, /\bknown (?:issues?|limits?)\b/i] },
  { key: "oncall", patterns: [/\bon-?call\b/i, /\bescalation\b/i, /\bcontact\b/i] },
];

const PLACEHOLDER_RE = /^\s*(?:tbd|to ?do|fill in|n\/?a|pending)\s*\.?\s*$/i;

export async function checkRunbook(path: string): Promise<RunbookCheckResult> {
  const content = await readFile(path, "utf8");
  const sections = extractSections(content);

  const missingSections: string[] = [];
  const emptySections: string[] = [];
  const placeholderSections: string[] = [];

  for (const required of REQUIRED_SECTIONS) {
    const match = sections.find((s) =>
      required.patterns.some((p) => p.test(s.heading)),
    );
    if (!match) {
      missingSections.push(required.key);
      continue;
    }
    if (isEmpty(match.body)) {
      emptySections.push(required.key);
      continue;
    }
    if (isPlaceholder(match.body)) {
      placeholderSections.push(required.key);
    }
  }

  return {
    ok:
      missingSections.length === 0 &&
      emptySections.length === 0 &&
      placeholderSections.length === 0,
    missingSections,
    emptySections,
    placeholderSections,
  };
}

interface Section {
  heading: string;
  body: string;
}

/**
 * Parse markdown by heading lines. Accepts h2 (`##`) or h3 (`###`) section
 * boundaries; anything deeper is body content of the nearest ancestor.
 */
function extractSections(content: string): Section[] {
  const lines = content.split(/\r?\n/);
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    const headingMatch = /^\s*(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      if (current) sections.push(current);
      current = { heading: headingMatch[2]!, body: "" };
    } else if (current) {
      current.body += line + "\n";
    }
  }
  if (current) sections.push(current);
  return sections;
}

function isEmpty(body: string): boolean {
  // Strip HTML comments before checking — template scaffolding comments
  // don't count as content.
  const stripped = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  return stripped === "";
}

function isPlaceholder(body: string): boolean {
  const stripped = body.replace(/<!--[\s\S]*?-->/g, "");
  const nonEmptyLines = stripped
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (nonEmptyLines.length === 0) return false; // caught by isEmpty
  return nonEmptyLines.every((l) => PLACEHOLDER_RE.test(l));
}
