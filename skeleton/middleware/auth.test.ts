import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../server.js";
import { InMemoryUserStore } from "../store/user-store.js";

describe("Bearer-token auth middleware", () => {
  let store: InMemoryUserStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new InMemoryUserStore();
    app = createApp({ userStore: store, authToken: "secret-42" });
  });

  it("returns 401 + Error envelope when Authorization header is missing (OIN step 20)", async () => {
    const res = await request(app).get("/scim/v2/Users");

    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(/^application\/scim\+json/);
    expect(res.body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    expect(res.body.status).toBe("401");
  });

  it("returns 401 when Authorization header has wrong scheme", async () => {
    const res = await request(app)
      .get("/scim/v2/Users")
      .set("Authorization", "Basic dXNlcjpwYXNz");

    expect(res.status).toBe(401);
  });

  it("returns 401 when bearer token is wrong", async () => {
    const res = await request(app)
      .get("/scim/v2/Users")
      .set("Authorization", "Bearer wrong-token");

    expect(res.status).toBe(401);
  });

  it("returns 200 when bearer token is correct", async () => {
    const res = await request(app)
      .get("/scim/v2/Users")
      .set("Authorization", "Bearer secret-42");

    expect(res.status).toBe(200);
  });

  it("enforces auth on POST /Users", async () => {
    const res = await request(app)
      .post("/scim/v2/Users")
      .send({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "a@example.com",
        active: true,
      });
    expect(res.status).toBe(401);
  });

  it("enforces auth on PATCH /Users/:id", async () => {
    const u = await store.create({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "b@example.com",
      active: true,
    });
    const res = await request(app)
      .patch(`/scim/v2/Users/${u.id}`)
      .send({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", value: { active: false } }],
      });
    expect(res.status).toBe(401);
  });

  it("allows /ServiceProviderConfig without auth by default (metadata is public)", async () => {
    const res = await request(app).get("/scim/v2/ServiceProviderConfig");
    expect(res.status).toBe(200);
  });

  it("when authToken is omitted, auth is disabled entirely (dev-mode convenience)", async () => {
    const openApp = createApp({ userStore: store }); // no authToken
    const res = await request(openApp).get("/scim/v2/Users");
    expect(res.status).toBe(200);
  });
});
