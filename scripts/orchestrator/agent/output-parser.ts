/**
 * Output parser for agent-emitted file blocks.
 *
 * Why this format (not JSON):
 *   JSON string values require escaping every newline, backslash, and
 *   quote inside file contents. TypeScript files are full of all three.
 *   An LLM trying to emit JSON with embedded code reliably fails on
 *   long files — the escape consistency drops off a cliff past a few
 *   hundred lines. Block-delimited format is robust to any byte
 *   sequence inside CONTENT, including unescaped backticks, quotes,
 *   and newlines.
 *
 * Why path safety checks:
 *   Agent output is untrusted input from an LLM. A bug or prompt
 *   injection could emit a path like `../../../etc/passwd` that, if
 *   written via GitHub API or filesystem, would be a security
 *   incident. Reject traversal + absolute paths at the parse boundary
 *   so downstream writers never see them.
 */
import type { GeneratedFile } from "../types.js";

export interface ParseSuccess {
  ok: true;
  files: GeneratedFile[];
  warnings: string[];
}

export interface ParseFailure {
  ok: false;
  error: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

const BLOCK_START = /^---FILE:\s*(.*?)\s*$/;
const MESSAGE_MARKER = /^---MESSAGE:\s*(.*?)\s*$/;
const CONTENT_MARKER = /^---CONTENT---\s*$/;
const END_MARKER = /^---END---\s*$/;

export function parseAgentOutput(raw: string): ParseResult {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const files: GeneratedFile[] = [];
  const warnings: string[] = [];
  const seenPaths = new Set<string>();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const startMatch = BLOCK_START.exec(line);
    if (!startMatch) {
      i++;
      continue;
    }

    // Found a block start. Consume until END_MARKER.
    const blockStart = i;
    const path = startMatch[1]!.trim();

    if (path === "") {
      return { ok: false, error: `empty path in FILE marker at line ${blockStart + 1}` };
    }
    if (path.startsWith("/")) {
      return { ok: false, error: `absolute path not allowed: ${path}` };
    }
    if (path.split("/").some((seg) => seg === ".." || seg === ".")) {
      return { ok: false, error: `path traversal (..) not allowed: ${path}` };
    }

    // Next non-blank line should be MESSAGE marker.
    i++;
    while (i < lines.length && lines[i]!.trim() === "") i++;
    if (i >= lines.length) {
      return { ok: false, error: `block at line ${blockStart + 1} missing MESSAGE marker (reached EOF)` };
    }
    const messageMatch = MESSAGE_MARKER.exec(lines[i]!);
    if (!messageMatch) {
      return { ok: false, error: `block at line ${blockStart + 1} missing MESSAGE marker (got: ${lines[i]})` };
    }
    const message = messageMatch[1]!.trim();

    // Next non-blank line should be CONTENT marker.
    i++;
    while (i < lines.length && lines[i]!.trim() === "") i++;
    if (i >= lines.length) {
      return { ok: false, error: `block for ${path} missing CONTENT marker (reached EOF)` };
    }
    if (!CONTENT_MARKER.test(lines[i]!)) {
      return { ok: false, error: `block for ${path} missing CONTENT marker (got: ${lines[i]})` };
    }
    i++;

    // Accumulate content until END_MARKER.
    const contentStart = i;
    while (i < lines.length && !END_MARKER.test(lines[i]!)) {
      i++;
    }
    if (i >= lines.length) {
      // Trailing-block truncation is common with LLM output-token ceilings.
      // Instead of hard-fail-discarding all the COMPLETE blocks we already
      // parsed, drop the unterminated block with a warning and return what
      // we have. Caller can treat low file count as a retry signal.
      warnings.push(`truncated block discarded: ${path} (likely LLM max_tokens hit)`);
      break;
    }
    const contentLines = lines.slice(contentStart, i);
    // Trim leading + trailing blank lines; preserve internal whitespace.
    let startIdx = 0;
    while (startIdx < contentLines.length && contentLines[startIdx]!.trim() === "") startIdx++;
    let endIdx = contentLines.length;
    while (endIdx > startIdx && contentLines[endIdx - 1]!.trim() === "") endIdx--;
    const content = contentLines.slice(startIdx, endIdx).join("\n");

    if (seenPaths.has(path)) {
      warnings.push(`duplicate path: ${path}`);
      // Replace previous entry with the newer one.
      const idx = files.findIndex((f) => f.path === path);
      files[idx] = { path, message, content };
    } else {
      seenPaths.add(path);
      files.push({ path, message, content });
    }

    i++; // consume END marker
  }

  return { ok: true, files, warnings };
}
