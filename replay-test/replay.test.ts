/**
 * Replay-test runner — the EVAL LAW golden set for the skeleton.
 *
 * Loads each fixture under fixtures/okta-payloads/<scenario>/ and replays
 * `request.http` against a fresh skeleton instance. Asserts semantic
 * equivalence against `response.http`:
 *   - HTTP status matches
 *   - Response Content-Type is application/scim+json
 *   - Structural match on schemas, userName, active, etc.
 *   - Dynamic fields (id, meta.created, meta.lastModified) are NOT
 *     exact-matched because our store generates them
 *
 * Fixtures require specific preconditions — each fixture's test spec
 * seeds the store as the scenario demands.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { createApp } from "../skeleton/server.js";
import { InMemoryUserStore } from "../skeleton/store/user-store.js";
import type { StoredUser } from "../skeleton/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, "..", "fixtures", "okta-payloads");

interface ParsedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

interface ParsedResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Parse a raw `.http` request file: start-line + headers + blank line + body. */
function parseRequestFile(raw: string): ParsedRequest {
  const [headerBlock, ...bodyParts] = raw.split(/\r?\n\r?\n/);
  const bodyRaw = bodyParts.join("\n\n").trim();
  const lines = (headerBlock ?? "").split(/\r?\n/);
  const startLine = lines[0] ?? "";
  const match = /^([A-Z]+)\s+(\S+)(?:\s+HTTP\/\S+)?$/.exec(startLine);
  if (!match) throw new Error(`Invalid request start-line: ${startLine}`);
  const method = match[1]!;
  let path = match[2]!;
  // Strip absolute URL → path only (supertest needs relative)
  const absMatch = /^https?:\/\/[^/]+(\/.*)$/.exec(path);
  if (absMatch) path = absMatch[1]!;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  const body = bodyRaw === "" ? undefined : JSON.parse(bodyRaw);
  return { method, path, headers, body };
}

/** Parse a raw `.http` response file: `HTTP/1.1 <status> ...` + headers + body. */
function parseResponseFile(raw: string): ParsedResponse {
  const [headerBlock, ...bodyParts] = raw.split(/\r?\n\r?\n/);
  const bodyRaw = bodyParts.join("\n\n").trim();
  const lines = (headerBlock ?? "").split(/\r?\n/);
  const startLine = lines[0] ?? "";
  const statusMatch = /^HTTP\/\S+\s+(\d{3})\b/.exec(startLine);
  if (!statusMatch) throw new Error(`Invalid response start-line: ${startLine}`);
  const status = Number.parseInt(statusMatch[1]!, 10);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  const body = bodyRaw === "" ? undefined : JSON.parse(bodyRaw);
  return { status, headers, body };
}

/**
 * Compare actual vs expected body with dynamic-field tolerance.
 * Ignores id + meta.* because our store generates them fresh.
 * For nested Resources arrays (ListResponse), applies recursively.
 */
function expectSemanticMatch(actual: unknown, expected: unknown): void {
  if (expected === null || expected === undefined) {
    expect(actual).toBe(expected);
    return;
  }
  if (typeof expected !== "object") {
    expect(actual).toBe(expected);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    const actualArr = actual as unknown[];
    expect(actualArr).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expectSemanticMatch(actualArr[i], expected[i]);
    }
    return;
  }
  // Object case: structural match with exclusions.
  expect(typeof actual).toBe("object");
  expect(actual).not.toBeNull();
  const expectedObj = expected as Record<string, unknown>;
  const actualObj = actual as Record<string, unknown>;
  for (const [key, expValue] of Object.entries(expectedObj)) {
    if (key === "id") {
      // Expected placeholder; actual is store-generated. Just assert presence + shape.
      expect(typeof actualObj[key]).toBe("string");
      expect((actualObj[key] as string).length).toBeGreaterThan(0);
      continue;
    }
    if (key === "meta") {
      expect(typeof actualObj[key]).toBe("object");
      continue; // skip deep-compare on meta — timestamps + location vary
    }
    expectSemanticMatch(actualObj[key], expValue);
  }
}

describe("replay — fixtures/okta-payloads against skeleton", () => {
  it("user-create: POST creates a user and returns 201 + expected body shape", async () => {
    const dir = join(FIXTURES_ROOT, "user-create");
    const req = parseRequestFile(readFileSync(join(dir, "request.http"), "utf8"));
    const expected = parseResponseFile(readFileSync(join(dir, "response.http"), "utf8"));

    const app = createApp({ userStore: new InMemoryUserStore() }); // no auth
    let test = request(app)[req.method.toLowerCase() as "post"](req.path);
    for (const [name, value] of Object.entries(req.headers)) {
      if (name === "authorization") continue; // placeholder <TOKEN>; skeleton no-auth mode
      test = test.set(name, value);
    }
    const res =
      req.body !== undefined
        ? await test.send(req.body as string | object)
        : await test;

    expect(res.status).toBe(expected.status);
    expect(res.headers["content-type"]).toMatch(/^application\/scim\+json/);
    expectSemanticMatch(res.body, expected.body);
  });

  it("user-filter-username: GET /Users?filter=userName eq ... finds the pre-seeded user", async () => {
    const dir = join(FIXTURES_ROOT, "user-filter-username");
    const req = parseRequestFile(readFileSync(join(dir, "request.http"), "utf8"));
    const expected = parseResponseFile(readFileSync(join(dir, "response.http"), "utf8"));

    const store = new InMemoryUserStore();
    // Precondition per fixture notes.md: a user with userName matching the
    // filter must already exist. Seed it.
    await store.create({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "user-001@example.com",
      name: { givenName: "User", familyName: "One" },
      emails: [{ primary: true, value: "user-001@example.com", type: "work" }],
      active: true,
    });

    const app = createApp({ userStore: store });
    const res = await request(app).get(req.path);

    expect(res.status).toBe(expected.status);
    expect(res.headers["content-type"]).toMatch(/^application\/scim\+json/);
    expectSemanticMatch(res.body, expected.body);
  });

  it("user-patch-deactivate: PATCH active:false returns 200 with updated body", async () => {
    const dir = join(FIXTURES_ROOT, "user-patch-deactivate");
    const reqRaw = readFileSync(join(dir, "request.http"), "utf8");
    const expected = parseResponseFile(readFileSync(join(dir, "response.http"), "utf8"));

    const store = new InMemoryUserStore();
    // Fixture hard-codes the URL path with id 00u00000000000000001 — seed a
    // user first, then REPLACE the placeholder id in the request path with
    // the store-generated id. This is the documented normalization boundary
    // per fixtures/okta-payloads/README.md.
    const seeded: StoredUser = await store.create({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "user-001@example.com",
      name: { givenName: "User", familyName: "One" },
      emails: [{ primary: true, value: "user-001@example.com", type: "work" }],
      active: true,
    });

    const reqWithRealId = reqRaw.replace("00u00000000000000001", seeded.id);
    const req = parseRequestFile(reqWithRealId);

    const app = createApp({ userStore: store });
    let test = request(app)[req.method.toLowerCase() as "patch"](req.path);
    for (const [name, value] of Object.entries(req.headers)) {
      if (name === "authorization") continue;
      test = test.set(name, value);
    }
    const res = await test.send(req.body as string | object);

    expect(res.status).toBe(expected.status);
    expect(res.headers["content-type"]).toMatch(/^application\/scim\+json/);
    expect(res.body.active).toBe(false); // the thing the fixture exercises
    expect(res.body.userName).toBe("user-001@example.com");
    expect(res.body.id).toBe(seeded.id);
  });
});
