import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../server.js";

describe("GET /scim/v2/ServiceProviderConfig", () => {
  const app = createApp();

  it("returns 200 with a SCIM ServiceProviderConfig envelope per RFC 7644 §4", async () => {
    const res = await request(app).get("/scim/v2/ServiceProviderConfig");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/scim\+json/);

    const body = res.body;
    expect(body.schemas).toEqual([
      "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
    ]);
    expect(body.patch?.supported).toBe(true); // per okta-dialect.md §10: Okta skips apps without patch.supported
    expect(body.filter?.supported).toBe(true);
    expect(typeof body.filter?.maxResults).toBe("number");
    expect(body.bulk?.supported).toBe(false);
    expect(body.changePassword?.supported).toBe(false);
    expect(body.sort?.supported).toBe(false);
    expect(body.etag?.supported).toBe(false);
    expect(Array.isArray(body.authenticationSchemes)).toBe(true);
  });

  it("declares a filter.maxResults <= 200 honestly (never claims more than it delivers)", async () => {
    const res = await request(app).get("/scim/v2/ServiceProviderConfig");

    expect(res.body.filter.maxResults).toBeGreaterThan(0);
    expect(res.body.filter.maxResults).toBeLessThanOrEqual(200);
  });
});

describe("GET /scim/v2/Schemas", () => {
  const app = createApp();

  it("returns 200 with a ListResponse containing User + Group schemas", async () => {
    const res = await request(app).get("/scim/v2/Schemas");

    expect(res.status).toBe(200);
    expect(res.body.schemas).toEqual([
      "urn:ietf:params:scim:api:messages:2.0:ListResponse",
    ]);
    expect(res.body.totalResults).toBeGreaterThanOrEqual(2);

    const userSchema = res.body.Resources.find(
      (r: { id: string }) => r.id === "urn:ietf:params:scim:schemas:core:2.0:User",
    );
    const groupSchema = res.body.Resources.find(
      (r: { id: string }) => r.id === "urn:ietf:params:scim:schemas:core:2.0:Group",
    );
    expect(userSchema).toBeDefined();
    expect(groupSchema).toBeDefined();
  });
});

describe("GET /scim/v2/ResourceTypes", () => {
  const app = createApp();

  it("returns 200 with a ListResponse listing User + Group resource types", async () => {
    const res = await request(app).get("/scim/v2/ResourceTypes");

    expect(res.status).toBe(200);
    expect(res.body.totalResults).toBeGreaterThanOrEqual(2);
    const names = res.body.Resources.map((r: { name: string }) => r.name);
    expect(names).toContain("User");
    expect(names).toContain("Group");
  });
});
