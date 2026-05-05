/**
 * Front-matter extractor — pulls YAML from a Linear ticket description.
 *
 * The ticket template at ticket-templates/new-scim-connector.md embeds
 * the machine-parseable contract in a `---` fenced YAML block at document
 * start. This parser isolates that block, parses it with the `yaml`
 * library, and validates the result is an object (not a scalar or array).
 *
 * Returns a structured Result so callers can dispatch cleanly on the
 * three failure modes (no fence, malformed YAML, non-object top level).
 */
import { parse as parseYaml } from "yaml";

export type ExtractResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: "no-yaml-frontmatter"; detail: string }
  | { ok: false; reason: "yaml-parse-error"; detail: string };

export function extractFrontMatter(markdown: string): ExtractResult {
  // Normalize CRLF so downstream regex + line handling stays simple.
  const normalized = markdown.replace(/\r\n/g, "\n");

  // The fence MUST be at document start. A `---` later in the body is
  // markdown hr syntax, not front-matter.
  const match = /^---\n([\s\S]*?)\n---(\n|$)/.exec(normalized);
  if (!match) {
    return { ok: false, reason: "no-yaml-frontmatter", detail: "no --- fence at document start" };
  }

  const yamlBody = match[1] ?? "";

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBody);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "yaml-parse-error", detail: message };
  }

  if (parsed === null || parsed === undefined) {
    return { ok: false, reason: "yaml-parse-error", detail: "front-matter is empty" };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "yaml-parse-error", detail: "front-matter must be a YAML object, got a scalar or array" };
  }

  return { ok: true, data: parsed as Record<string, unknown> };
}
