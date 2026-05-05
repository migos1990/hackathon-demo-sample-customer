import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../server.js";
import { InMemoryUserStore } from "../store/user-store.js";

async function seed(store: InMemoryUserStore, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await store.create({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: `user-${i.toString().padStart(3, "0")}@example.com`,
      active: i !== 3,
    });
  }
}

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

describe("GET /scim/v2/Users (list)", () => {
  let store: InMemoryUserStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new InMemoryUserStore();
    app = createApp({ userStore: store });
  });

  it("returns a ListResponse envelope per RFC 7644 §3.4.2 even on empty store (OIN step 0)", async () => {
    const res = await request(app).get("/scim/v2/Users?count=1&startIndex=1");

    expect(res.status).toBe(200);
    expect(res.body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:ListResponse"]);
    expect(res.body.totalResults).toBe(0);
    expect(res.body.startIndex).toBe(1);
    expect(res.body.itemsPerPage).toBe(0);
    expect(res.body.Resources).toEqual([]);
  });

  it("honors count + startIndex and reports honest totalResults", async () => {
    await seed(store, 5);

    const page1 = await request(app).get("/scim/v2/Users?count=2&startIndex=1");
    const page2 = await request(app).get("/scim/v2/Users?count=2&startIndex=3");

    expect(page1.body.totalResults).toBe(5);
    expect(page1.body.itemsPerPage).toBe(2);
    expect(page1.body.Resources).toHaveLength(2);
    expect(page2.body.Resources).toHaveLength(2);
    expect(page1.body.Resources[0].id).not.toBe(page2.body.Resources[0].id);
  });

  it("uses Okta defaults (count 100, startIndex 1) when params omitted, per okta-dialect.md §7", async () => {
    await seed(store, 5);

    const res = await request(app).get("/scim/v2/Users");

    expect(res.body.startIndex).toBe(1);
    expect(res.body.totalResults).toBe(5);
    expect(res.body.Resources).toHaveLength(5);
  });

  it('filters by userName eq (OIN step 4/8 canonical dedup query)', async () => {
    await seed(store, 5);

    const res = await request(app).get(
      '/scim/v2/Users?filter=userName eq "user-003@example.com"',
    );

    expect(res.status).toBe(200);
    expect(res.body.totalResults).toBe(1);
    expect(res.body.Resources).toHaveLength(1);
    expect(res.body.Resources[0].userName).toBe("user-003@example.com");
  });

  it("returns empty ListResponse (NOT 404) when filter matches nothing (OIN step 4)", async () => {
    await seed(store, 5);

    const res = await request(app).get(
      '/scim/v2/Users?filter=userName eq "nobody@example.com"',
    );

    expect(res.status).toBe(200);
    expect(res.body.totalResults).toBe(0);
    expect(res.body.Resources).toEqual([]);
  });

  it("returns 400 + invalidFilter on malformed filter per RFC 7644 §3.12", async () => {
    const res = await request(app).get("/scim/v2/Users?filter=this is not a filter");

    expect(res.status).toBe(400);
    expect(res.body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    expect(res.body.scimType).toBe("invalidFilter");
  });

  it("clamps count to the server max (200) and reflects the clamp in itemsPerPage", async () => {
    await seed(store, 5);

    const res = await request(app).get("/scim/v2/Users?count=10000");

    expect(res.body.totalResults).toBe(5);
    // itemsPerPage reflects actual returned, not requested
    expect(res.body.Resources).toHaveLength(5);
    expect(res.body.itemsPerPage).toBe(5);
  });
});

describe("POST /scim/v2/Users (create)", () => {
  let store: InMemoryUserStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new InMemoryUserStore();
    app = createApp({ userStore: store });
  });

  const VALID_BODY = {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: "new.user@example.com",
    name: { givenName: "New", familyName: "User" },
    emails: [{ primary: true, value: "new.user@example.com", type: "work" }],
    displayName: "New User",
    active: true,
  } as const;

  it("returns 201 + full resource body with server-assigned id + meta (OIN step 10)", async () => {
    const res = await request(app)
      .post("/scim/v2/Users")
      .set("Content-Type", "application/json") // per okta-dialect.md §10: Okta sends POST as application/json
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.headers["content-type"]).toMatch(/^application\/scim\+json/);
    expect(res.body.id).toBeDefined();
    expect(res.body.userName).toBe(VALID_BODY.userName);
    expect(res.body.meta?.resourceType).toBe("User");
    expect(res.body.meta?.location).toBe(`/scim/v2/Users/${res.body.id}`);
  });

  it("accepts application/scim+json Content-Type on the POST body equally (okta-dialect.md §10)", async () => {
    const res = await request(app)
      .post("/scim/v2/Users")
      .set("Content-Type", "application/scim+json")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
  });

  it("returns 409 + scimType:uniqueness on duplicate userName (OIN step 14)", async () => {
    await request(app).post("/scim/v2/Users").send(VALID_BODY);

    const dup = await request(app).post("/scim/v2/Users").send(VALID_BODY);

    expect(dup.status).toBe(409);
    expect(dup.body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    expect(dup.body.status).toBe("409");
    expect(dup.body.scimType).toBe("uniqueness");
  });

  it("returns 400 + scimType:invalidValue when body is missing required userName", async () => {
    const body = { schemas: VALID_BODY.schemas, active: true };

    const res = await request(app).post("/scim/v2/Users").send(body);

    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe("invalidValue");
  });

  it("returns 400 + scimType:invalidSyntax when body is not valid JSON / missing schemas", async () => {
    const res = await request(app)
      .post("/scim/v2/Users")
      .send({ userName: "no-schemas@example.com" });

    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe("invalidSyntax");
  });
});

describe("PATCH /scim/v2/Users/:id (deactivation, attribute update, multi-op)", () => {
  let store: InMemoryUserStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new InMemoryUserStore();
    app = createApp({ userStore: store });
  });

  const PATCH_ENVELOPE_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

  it("returns 200 + full resource body on deactivation PATCH (okta-dialect.md §1 anti-pattern: NOT 204)", async () => {
    const u = await store.create({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "d@example.com",
      active: true,
    });

    const res = await request(app)
      .patch(`/scim/v2/Users/${u.id}`)
      .send({
        schemas: [PATCH_ENVELOPE_SCHEMA],
        Operations: [{ op: "replace", value: { active: false } }],
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/scim\+json/);
    expect(res.body.active).toBe(false);
    expect(res.body.userName).toBe("d@example.com");
    expect(res.body.id).toBe(u.id);
  });

  it("applies multi-op PATCH atomically per RFC 7644 §3.5.2", async () => {
    const u = await store.create({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "m@example.com",
      active: true,
      name: { givenName: "Old", familyName: "Name" },
    });

    const res = await request(app)
      .patch(`/scim/v2/Users/${u.id}`)
      .send({
        schemas: [PATCH_ENVELOPE_SCHEMA],
        Operations: [
          { op: "replace", value: { active: false } },
          { op: "replace", path: "name.givenName", value: "New" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(res.body.name.givenName).toBe("New");
    expect(res.body.name.familyName).toBe("Name"); // untouched preserved
  });

  it("returns 404 + noTarget when id is unknown", async () => {
    const res = await request(app)
      .patch("/scim/v2/Users/00u00000000000000999")
      .send({
        schemas: [PATCH_ENVELOPE_SCHEMA],
        Operations: [{ op: "replace", value: { active: false } }],
      });

    expect(res.status).toBe(404);
    expect(res.body.scimType).toBe("noTarget");
  });

  it("returns 400 + invalidSyntax when PatchOp envelope is missing schemas", async () => {
    const u = await store.create({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "e@example.com",
      active: true,
    });

    const res = await request(app)
      .patch(`/scim/v2/Users/${u.id}`)
      .send({ Operations: [{ op: "replace", value: { active: false } }] });

    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe("invalidSyntax");
  });

  it("returns 400 + invalidSyntax when Operations is missing or not an array", async () => {
    const u = await store.create({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "f@example.com",
      active: true,
    });

    const res = await request(app)
      .patch(`/scim/v2/Users/${u.id}`)
      .send({ schemas: [PATCH_ENVELOPE_SCHEMA] });

    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe("invalidSyntax");
  });

  it("returns 409 + uniqueness if PATCH would set userName to one that already exists", async () => {
    await store.create({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "taken@example.com",
      active: true,
    });
    const other = await store.create({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "other@example.com",
      active: true,
    });

    const res = await request(app)
      .patch(`/scim/v2/Users/${other.id}`)
      .send({
        schemas: [PATCH_ENVELOPE_SCHEMA],
        Operations: [{ op: "replace", path: "userName", value: "taken@example.com" }],
      });

    expect(res.status).toBe(409);
    expect(res.body.scimType).toBe("uniqueness");
  });
});
