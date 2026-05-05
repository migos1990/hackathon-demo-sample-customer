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
 * Parse markdown into top-level sections.
 *
 * "Top level" is document-adaptive: the MINIMUM heading depth present
 * (## if any h2 exists, else ### if only h3s exist). h3 subsections
 * INSIDE an h2 become part of the h2's body — they're not separate
 * top-level sections. This matters because agent-generated runbooks
 * routinely use h3 for subsections (### Prerequisites under ## Deployment).
 *
 * Previous implementation treated every h2/h3 as a new section and
 * falsely flagged ## Deployment as empty when its content was under
 * ### sub-headings. Caught by running the checker against an agent-
 * generated RUNBOOK that was actually well-formed.
 */
function extractSections(content: string): Section[] {
  const lines = content.split(/\r?\n/);

  // Detect the top-level heading depth in this document.
  const HEADING_RE = /^\s*(#{2,6})\s+.+$/;
  let minDepth = 0; // 0 = not found yet
  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (!match) continue;
    const depth = match[1]!.length;
    if (minDepth === 0 || depth < minDepth) minDepth = depth;
  }
  if (minDepth === 0) return [];

  // Only headings at exactly `minDepth` are section boundaries. Deeper
  // headings are body content of their nearest ancestor top-level section.
  const sectionBoundary = new RegExp(`^\\s*#{${minDepth}}\\s+(.+?)\\s*$`);

  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of lines) {
    const match = sectionBoundary.exec(line);
    if (match) {
      if (current) sections.push(current);
      current = { heading: match[1]!, body: "" };
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
