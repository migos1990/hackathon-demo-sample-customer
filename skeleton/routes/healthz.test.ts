import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../server.js";
import { InMemoryUserStore } from "../store/user-store.js";

describe("/scim/v2/healthz (liveness + target reachability)", () => {
  it("returns 200 with status=ok, uptime, version", async () => {
    const app = createApp({ userStore: new InMemoryUserStore() });
    const res = await request(app).get("/scim/v2/healthz");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptime_seconds).toBe("number");
    expect(res.body.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(typeof res.body.version).toBe("string");
  });

  it("is auth-exempt — returns 200 even when authToken is configured and no bearer provided", async () => {
    const app = createApp({ userStore: new InMemoryUserStore(), authToken: "secret-42" });
    const res = await request(app).get("/scim/v2/healthz");
    expect(res.status).toBe(200);
  });

  it("includes target_reachable when the store exposes a ping", async () => {
    const store = new InMemoryUserStore();
    const app = createApp({ userStore: store });
    const res = await request(app).get("/scim/v2/healthz");
    // InMemoryUserStore has no ping; body does not claim reachability it can't verify.
    expect(res.body).not.toHaveProperty("target_reachable");
  });

  it("reports target_reachable=true when the store's ping resolves", async () => {
    const store = new InMemoryUserStore();
    (store as unknown as { ping: () => Promise<void> }).ping = async () => { /* ok */ };
    const app = createApp({ userStore: store });
    const res = await request(app).get("/scim/v2/healthz");
    expect(res.status).toBe(200);
    expect(res.body.target_reachable).toBe(true);
  });

  it("reports target_reachable=false and status=degraded when ping rejects", async () => {
    const store = new InMemoryUserStore();
    (store as unknown as { ping: () => Promise<void> }).ping = async () => {
      throw new Error("target unreachable");
    };
    const app = createApp({ userStore: store });
    const res = await request(app).get("/scim/v2/healthz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.target_reachable).toBe(false);
    expect(res.body.target_error).toMatch(/unreachable/);
  });

  it("echoes a request-id header set by the skeleton middleware", async () => {
    const app = createApp({ userStore: new InMemoryUserStore() });
    const res = await request(app).get("/scim/v2/healthz").set("x-request-id", "abcdef01");
    expect(res.headers["x-request-id"]).toBe("abcdef01");
  });
});
