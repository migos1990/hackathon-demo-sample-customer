import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { requestId } from "./request-id.js";

describe("requestId middleware", () => {
  it("generates a short opaque id when no X-Request-Id header present", async () => {
    const app = express();
    app.use(requestId());
    app.get("/", (req, res) => res.json({ id: (res.locals as { request_id?: string }).request_id }));
    const r = await request(app).get("/");
    expect(r.body.id).toMatch(/^[a-f0-9]{16}$/);
    expect(r.headers["x-request-id"]).toBe(r.body.id);
  });

  it("preserves an incoming X-Request-Id header if it looks safe", async () => {
    const app = express();
    app.use(requestId());
    app.get("/", (_req, res) => res.json({ id: (res.locals as { request_id?: string }).request_id }));
    const r = await request(app).get("/").set("x-request-id", "client-supplied-abc");
    expect(r.body.id).toBe("client-supplied-abc");
    expect(r.headers["x-request-id"]).toBe("client-supplied-abc");
  });

  it("rejects overly-long inbound ids and generates a fresh one (defense vs log-injection)", async () => {
    const app = express();
    app.use(requestId());
    app.get("/", (_req, res) => res.json({ id: (res.locals as { request_id?: string }).request_id }));
    const tooLong = "x".repeat(200);
    const r = await request(app).get("/").set("x-request-id", tooLong);
    expect(r.body.id).not.toBe(tooLong);
    expect(r.body.id).toMatch(/^[a-f0-9]{16}$/);
  });

  it("rejects inbound ids with control characters or newlines (log-forging defense)", () => {
    // Node HTTP layer already blocks bad header bytes on the wire, so we
    // can't reach this path through supertest. Call the middleware directly
    // with a synthetic request to prove the regex guard rejects newlines
    // and the fresh-id path runs.
    const mw = requestId();
    const captures: string[] = [];
    const fakeReq = { headers: { "x-request-id": "ok-id\nfake: INJECTED" } } as unknown as Parameters<typeof mw>[0];
    const fakeRes = {
      locals: {},
      setHeader: (_n: string, v: string) => captures.push(v),
    } as unknown as Parameters<typeof mw>[1];
    mw(fakeReq, fakeRes, () => { /* next */ });
    const id = (fakeRes.locals as { request_id?: string }).request_id;
    expect(id).toBeDefined();
    expect(id).not.toContain("\n");
    expect(id).toMatch(/^[a-f0-9]{16}$/);
    expect(captures[0]).toBe(id);
  });

  it("generates distinct ids across sequential requests", async () => {
    const app = express();
    app.use(requestId());
    app.get("/", (_req, res) => res.json({ id: (res.locals as { request_id?: string }).request_id }));
    const a = await request(app).get("/");
    const b = await request(app).get("/");
    expect(a.body.id).not.toBe(b.body.id);
  });
});
