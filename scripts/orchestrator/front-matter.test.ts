import { describe, it, expect } from "vitest";
import { extractFrontMatter } from "./front-matter.js";

describe("extractFrontMatter", () => {
  it("extracts YAML between --- delimiters at document start", () => {
    const md = `---
customer_slug: acme-hr
auth_method: bearer
---

# Body here
`;
    const r = extractFrontMatter(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.customer_slug).toBe("acme-hr");
      expect(r.data.auth_method).toBe("bearer");
    }
  });

  it("handles CRLF line endings (Windows-authored tickets)", () => {
    const md = "---\r\ncustomer_slug: acme-hr\r\n---\r\n\r\nbody";
    const r = extractFrontMatter(md);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.customer_slug).toBe("acme-hr");
  });

  it("returns no-yaml-frontmatter when there's no --- fence", () => {
    const r = extractFrontMatter("just a description, no front-matter here");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-yaml-frontmatter");
  });

  it("returns no-yaml-frontmatter on an empty description", () => {
    const r = extractFrontMatter("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-yaml-frontmatter");
  });

  it("returns no-yaml-frontmatter when only one --- is present (unterminated)", () => {
    const r = extractFrontMatter("---\ncustomer_slug: x\n# no closing fence");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-yaml-frontmatter");
  });

  it("returns yaml-parse-error on malformed YAML inside the fence", () => {
    const md = `---
customer_slug: [not closed bracket
---

body
`;
    const r = extractFrontMatter(md);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("yaml-parse-error");
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });

  it("returns yaml-parse-error when the front-matter is scalar, not an object", () => {
    const md = `---
"just a string"
---
`;
    const r = extractFrontMatter(md);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("yaml-parse-error");
  });

  it("preserves nested object structure (compliance:, environments:, etc.)", () => {
    const md = `---
customer_slug: x
environments:
  dev: https://dev.example.com
  prod: https://api.example.com
required_ops:
  users_create: true
  users_delete: false
---
`;
    const r = extractFrontMatter(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const envs = r.data.environments as Record<string, string>;
      expect(envs.dev).toBe("https://dev.example.com");
      const ops = r.data.required_ops as Record<string, boolean>;
      expect(ops.users_create).toBe(true);
      expect(ops.users_delete).toBe(false);
    }
  });

  it("ignores a --- that appears in the body after a valid front-matter block", () => {
    const md = `---
customer_slug: x
---

# body

A horizontal rule:
---
still body
`;
    const r = extractFrontMatter(md);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.customer_slug).toBe("x");
  });
});
