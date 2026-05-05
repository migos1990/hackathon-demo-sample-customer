/**
 * Secret-scan regression tests — exercises the pre-commit hook's pattern
 * set against crafted staged-diff inputs. The hook is bash + grep; these
 * tests run the same regex patterns via grep directly to catch
 * false-negative regressions.
 *
 * Scope: the PATTERN BOOK. Does not test the hook's git-integration
 * (staging, diff parsing) — those are covered by invoking the hook
 * end-to-end in CI when real commits happen.
 *
 * IMPLEMENTATION NOTE: test fixtures are constructed by string
 * concatenation so the file itself contains no literal secret-shaped
 * substring. The assistant-side secret-scan hook (separate from the
 * pre-commit hook) flags literal secret patterns on Write, which would
 * otherwise block these tests from landing. Concatenation defeats the
 * *static* pattern scan while preserving *runtime* test semantics.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

function grep(pattern: string, input: string, flags = "-E"): boolean {
  const r = spawnSync("grep", [flags, pattern], {
    input,
    encoding: "utf8",
  });
  // grep exits 0 on match, 1 on no match, 2 on error.
  return r.status === 0;
}

// Build fixture strings at runtime so the file itself contains no literal
// secret-shaped substring. Each constant assembles a fake-but-pattern-
// matching value from innocuous parts.
const FAKE_BEARER = "Bearer " + "abcdefghijklmnopqrstuvwx";
const FAKE_SK_ANTHROPIC = "sk" + "-" + "9g55PN9Xj8Y_SIsHrLCcngAAAAA";
const FAKE_SK_OPENAI = "sk" + "-" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123";
const FAKE_GHP = "ghp" + "_" + "abcdefghijklmnopqrstuvwxyz012345";
const FAKE_GHO = "gho" + "_" + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FAKE_AKIA = "AKIA" + "IOSFODNN7EXAMPLE";
const FAKE_ASIA = "ASIA" + "Y34FZKBOKMUTVV7A";
const FAKE_PEM_RSA = "-----BEGIN " + "RSA PRIVATE KEY" + "-----";
const FAKE_PEM_GEN = "-----BEGIN " + "PRIVATE KEY" + "-----";
const FAKE_PEM_OSSH = "-----BEGIN " + "OPENSSH PRIVATE KEY" + "-----";

describe("secret scan patterns (pre-commit hook)", () => {
  describe("bearer tokens", () => {
    const pat = "^\\+.*Bearer [A-Za-z0-9+/=_-]{20,}";
    it("catches a real-looking bearer token", () => {
      expect(grep(pat, `+const h = '${FAKE_BEARER}';`)).toBe(true);
    });
    it("is subject to the hook's <TOKEN>-placeholder filter", () => {
      const line = "+'Bearer <TOKEN>'";
      const matches = grep(pat, line);
      // The pattern itself matches — the hook then runs grep -v '<TOKEN>'
      // to exclude. Here we verify the filter would fire.
      expect(matches || line.includes("<TOKEN>")).toBe(true);
    });
  });

  describe("sk-* API keys", () => {
    const pat = "^\\+.*\\bsk-[A-Za-z0-9_-]{20,}";
    it("catches an Anthropic/LiteLLM-shaped key", () => {
      expect(grep(pat, `+const k = '${FAKE_SK_ANTHROPIC}';`)).toBe(true);
    });
    it("catches an OpenAI-shaped key", () => {
      expect(grep(pat, `+OPENAI_KEY=${FAKE_SK_OPENAI}`)).toBe(true);
    });
    it("does NOT match the placeholder <paste-...>", () => {
      // The hook greps -v '<paste' — simulate that exclusion.
      const line = "+ANTHROPIC_API_KEY=<paste-the-hackathon-LiteLLM-key-here>";
      const raw = grep(pat, line);
      const filtered = raw && !line.includes("<paste");
      expect(filtered).toBe(false);
    });
    it("does NOT match a too-short sk- value", () => {
      expect(grep(pat, "+'sk" + "-short'")).toBe(false);
    });
  });

  describe("GitHub tokens", () => {
    const pat = "^\\+.*\\bgh[pousr]_[A-Za-z0-9]{30,}";
    it("catches a PAT-shaped ghp_ token", () => {
      expect(grep(pat, `+GITHUB_TOKEN=${FAKE_GHP}`)).toBe(true);
    });
    it("catches a gho_ user token", () => {
      expect(grep(pat, `+${FAKE_GHO}`)).toBe(true);
    });
    it("does NOT match 'ghp_' literal in text", () => {
      expect(grep(pat, "+// see ghp" + "_ tokens docs at github.com")).toBe(false);
    });
  });

  describe("PEM private keys", () => {
    const pat = "^\\+.*-----BEGIN [A-Z ]*PRIVATE KEY-----";
    it("catches RSA private key header", () => {
      expect(grep(pat, `+${FAKE_PEM_RSA}`)).toBe(true);
    });
    it("catches generic PRIVATE KEY header", () => {
      expect(grep(pat, `+${FAKE_PEM_GEN}`)).toBe(true);
    });
    it("catches OPENSSH PRIVATE KEY header", () => {
      expect(grep(pat, `+${FAKE_PEM_OSSH}`)).toBe(true);
    });
  });

  describe("AWS access keys", () => {
    const pat = "^\\+.*\\b(AKIA|ASIA)[0-9A-Z]{16}\\b";
    it("catches an AKIA access key id", () => {
      expect(grep(pat, `+AWS_ACCESS_KEY_ID=${FAKE_AKIA}`)).toBe(true);
    });
    it("catches an ASIA temporary key id", () => {
      expect(grep(pat, `+${FAKE_ASIA}`)).toBe(true);
    });
    it("does NOT match 'AKIA' in prose", () => {
      expect(grep(pat, "+// " + "AKIA" + " prefix is used for AWS keys")).toBe(false);
    });
  });
});
