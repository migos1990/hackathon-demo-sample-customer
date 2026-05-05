import { describe, it, expect } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  it("emits single-line JSON with ts, level, msg for info", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s) => lines.push(s) });
    log.info("hello", { foo: "bar" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
    expect(parsed.foo).toBe("bar");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("supports warn and error levels with matching level field", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s) => lines.push(s) });
    log.warn("a warning");
    log.error("an error", { code: 500 });
    expect(JSON.parse(lines[0]!).level).toBe("warn");
    expect(JSON.parse(lines[1]!).level).toBe("error");
    expect(JSON.parse(lines[1]!).code).toBe(500);
  });

  it("merges a persistent child-logger context into every line", () => {
    const lines: string[] = [];
    const root = createLogger({ write: (s) => lines.push(s) });
    const req = root.child({ request_id: "abc123" });
    req.info("incoming", { path: "/scim/v2/Users" });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.request_id).toBe("abc123");
    expect(parsed.path).toBe("/scim/v2/Users");
  });

  it("redacts Authorization header values in fields (secret hygiene)", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s) => lines.push(s) });
    log.info("request", { headers: { authorization: "Bearer real-secret-12345" } });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.headers.authorization).toBe("[REDACTED]");
    // Case-insensitive — real HTTP headers can arrive under "Authorization".
    lines.length = 0;
    log.info("request", { headers: { Authorization: "Bearer othersecret" } });
    expect(JSON.parse(lines[0]!).headers.Authorization).toBe("[REDACTED]");
  });

  it("redacts cookie header values too", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s) => lines.push(s) });
    log.info("request", { headers: { cookie: "session=abc123" } });
    expect(JSON.parse(lines[0]!).headers.cookie).toBe("[REDACTED]");
  });

  it("NEVER redacts non-secret fields even if named similarly", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s) => lines.push(s) });
    log.info("x", { authorization_mode: "bearer" });
    expect(JSON.parse(lines[0]!).authorization_mode).toBe("bearer");
  });

  it("silent mode suppresses all output", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s) => lines.push(s), level: "silent" });
    log.info("no");
    log.warn("no");
    log.error("no");
    expect(lines).toHaveLength(0);
  });

  it("level=warn suppresses info but keeps warn and error", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s) => lines.push(s), level: "warn" });
    log.info("dropped");
    log.warn("kept");
    log.error("kept");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).msg).toBe("kept");
  });

  it("serializes errors cleanly instead of silently dropping them", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s) => lines.push(s) });
    log.error("crash", { err: new Error("nope") });
    const parsed = JSON.parse(lines[0]!);
    // Error object is stringified to something useful, not "{}" or undefined.
    expect(JSON.stringify(parsed.err)).toMatch(/nope/);
  });

  it("handles circular references in fields without throwing", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s) => lines.push(s) });
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", a };
    a.b = b;
    log.info("circular", { a });
    expect(lines).toHaveLength(1);
    // Must emit something parseable even with the cycle.
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.msg).toBe("circular");
  });
});
