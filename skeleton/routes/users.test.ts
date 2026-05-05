import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../server.js";
import { InMemoryUserStore } from "../store/user-store.js";

describe("GET /scim/v2/Users/:id", () => {
  let store: InMemoryUserStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new InMemoryUserStore();
    app = createApp({ userStore: store });
  });

  it("returns 200 with the stored user per RFC 7644 §3.4.1", async () => {
    const created = await store.create({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "jane@example.com",
      name: { givenName: "Jane", familyName: "Doe" },
      active: true,
    });

    const res = await request(app).get(`/scim/v2/Users/${created.id}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/scim\+json/);
    expect(res.body.id).toBe(created.id);
    expect(res.body.userName).toBe("jane@example.com");
    expect(res.body.meta?.resourceType).toBe("User");
    expect(res.body.meta?.location).toBe(`/scim/v2/Users/${created.id}`);
  });

  it("returns 404 with RFC 7644 §3.12 Error envelope when id is unknown (OIN test suite step 22)", async () => {
    const res = await request(app).get("/scim/v2/Users/00u00000000000000999");

    expect(res.status).toBe(404);
    expect(res.body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    expect(res.body.status).toBe("404");
    expect(typeof res.body.detail).toBe("string");
    expect(res.body.detail.length).toBeGreaterThan(0);
  });

  it("sets Content-Type: application/scim+json on both 200 and 404 responses", async () => {
    const created = await store.create({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "ok@example.com",
      active: true,
    });
    const ok = await request(app).get(`/scim/v2/Users/${created.id}`);
    const notFound = await request(app).get("/scim/v2/Users/00u00000000000000999");

    expect(ok.headers["content-type"]).toMatch(/^application\/scim\+json/);
    expect(notFound.headers["content-type"]).toMatch(/^application\/scim\+json/);
  });
});
