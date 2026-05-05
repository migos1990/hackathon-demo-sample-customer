/**
 * Output parser tests — structured block format the LLM emits.
 *
 * Format:
 *   ---FILE: <path>
 *   ---MESSAGE: <commit message>
 *   ---CONTENT---
 *   <file contents, any number of lines>
 *   ---END---
 *
 * Repeated per file. Anything outside the delimited blocks is discarded
 * (lets the LLM narrate freely around the file emissions).
 *
 * Chose this over JSON: JSON breaks on unescaped newlines, backticks,
 * quotes — common in TypeScript file contents. Delimited block format
 * is robust to any byte sequence inside CONTENT blocks.
 */
import { describe, it, expect } from "vitest";
import { parseAgentOutput } from "./output-parser.js";

describe("parseAgentOutput — well-formed output", () => {
  it("parses a single file block", () => {
    const raw = `Here's the file I generated:

---FILE: connectors/foo/store.ts
---MESSAGE: feat(foo): initial store
---CONTENT---
export class FooStore {}
---END---

Done.`;
    const result = parseAgentOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual({
      path: "connectors/foo/store.ts",
      message: "feat(foo): initial store",
      content: "export class FooStore {}",
    });
  });

  it("parses multiple file blocks", () => {
    const raw = `---FILE: a.ts
---MESSAGE: add a
---CONTENT---
a
---END---

---FILE: b.ts
---MESSAGE: add b
---CONTENT---
b
---END---`;
    const result = parseAgentOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toHaveLength(2);
    expect(result.files[0]?.path).toBe("a.ts");
    expect(result.files[1]?.path).toBe("b.ts");
  });

  it("preserves content newlines, indentation, and special characters", () => {
    const raw = `---FILE: x.ts
---MESSAGE: m
---CONTENT---
export function f() {
  const s = \`template
    with newlines\`;
  return s.split("\\n");
}
---END---`;
    const result = parseAgentOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files[0]?.content).toContain("template\n    with newlines");
    expect(result.files[0]?.content).toContain("  const s =");
  });

  it("ignores LLM narration between blocks", () => {
    const raw = `I'll generate two files.

First, the store:

---FILE: a.ts
---MESSAGE: m
---CONTENT---
a
---END---

Then the server:

---FILE: b.ts
---MESSAGE: m
---CONTENT---
b
---END---

That's all.`;
    const result = parseAgentOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toHaveLength(2);
  });

  it("trims leading/trailing blank lines from content but preserves internal", () => {
    const raw = `---FILE: x.ts
---MESSAGE: m
---CONTENT---


const x = 1;

const y = 2;


---END---`;
    const result = parseAgentOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = result.files[0]?.content ?? "";
    expect(content.startsWith("const x")).toBe(true);
    expect(content.endsWith("const y = 2;")).toBe(true);
    expect(content).toContain("\n\nconst y");
  });
});

describe("parseAgentOutput — degenerate cases", () => {
  it("returns empty files list when the raw text has no blocks (LLM chose not to emit)", () => {
    const raw = "I don't have enough info to generate files. Please clarify.";
    const result = parseAgentOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toEqual([]);
  });

  it("fails on a block missing the CONTENT marker", () => {
    const raw = `---FILE: x.ts
---MESSAGE: m
---END---`;
    const result = parseAgentOutput(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/CONTENT/);
  });

  it("is lenient on a trailing unterminated block — keeps prior complete blocks, warns on the truncated one", () => {
    // Common LLM failure mode: output-token ceiling hits mid-block.
    // Hard-failing would discard ALL completed blocks; leniency lets
    // the caller decide whether to retry with higher maxTokens.
    const raw = `---FILE: a.ts
---MESSAGE: complete
---CONTENT---
full content here
---END---

---FILE: b.ts
---MESSAGE: truncated
---CONTENT---
this block never got its END marker before max_tokens hit`;
    const result = parseAgentOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe("a.ts");
    expect(result.warnings.some((w) => /truncated/i.test(w) && w.includes("b.ts"))).toBe(true);
  });

  it("hard-fails on a SOLE unterminated block (nothing to salvage)", () => {
    const raw = `---FILE: x.ts
---MESSAGE: m
---CONTENT---
body`;
    const result = parseAgentOutput(raw);
    // Even with leniency: no complete blocks parsed. Return empty + warning.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("fails on a block missing MESSAGE", () => {
    const raw = `---FILE: x.ts
---CONTENT---
body
---END---`;
    const result = parseAgentOutput(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/MESSAGE/);
  });

  it("fails when path attempts to escape the repo via ..", () => {
    const raw = `---FILE: ../../../../etc/passwd
---MESSAGE: m
---CONTENT---
root:x:0:0
---END---`;
    const result = parseAgentOutput(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/path|traversal|\.\./);
  });

  it("fails when path is absolute (starts with /)", () => {
    const raw = `---FILE: /etc/passwd
---MESSAGE: m
---CONTENT---
root
---END---`;
    const result = parseAgentOutput(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/absolute|\//);
  });

  it("fails when path is empty", () => {
    const raw = `---FILE:
---MESSAGE: m
---CONTENT---
body
---END---`;
    const result = parseAgentOutput(raw);
    expect(result.ok).toBe(false);
  });

  it("deduplicates — if the LLM emits the same path twice, last wins with a warning", () => {
    const raw = `---FILE: x.ts
---MESSAGE: v1
---CONTENT---
first
---END---

---FILE: x.ts
---MESSAGE: v2
---CONTENT---
second
---END---`;
    const result = parseAgentOutput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.content).toBe("second");
    expect(result.warnings).toContain("duplicate path: x.ts");
  });
});
