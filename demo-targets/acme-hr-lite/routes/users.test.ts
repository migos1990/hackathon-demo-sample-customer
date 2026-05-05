import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createAcmeHrApp } from "../server.js";
import { InMemoryAcmeHrStore } from "../store.js";

const SEED = {
  uid: "jdoe",
  cn: "Jane Doe",
  givenName: "Jane",
  sn: "Doe",
  mail: "jdoe@acme-hr.example.com",
  employeeNumber: "E-1234",
  title: "Senior Engineer",
  department: "R&D",
  enabled: true,
  memberOf: ["cn=engineers,ou=groups,dc=acme-hr,dc=example,dc=com"],
};

describe("AcmeHR-lite /users routes", () => {
  let store: InMemoryAcmeHrStore;

  beforeEach(() => {
    store = new InMemoryAcmeHrStore();
  });

  describe("no auth (dev mode — no apiToken configured)", () => {
    it("GET /users returns empty array when store is empty", async () => {
      const app = createAcmeHrApp({ store });
      const res = await request(app).get("/users");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("POST /users creates a user and returns 201 with the stored shape", async () => {
      const app = createAcmeHrApp({ store });
      const res = await request(app).post("/users").send(SEED);
      expect(res.status).toBe(201);
      expect(res.body.uid).toBe("jdoe");
      expect(res.body.cn).toBe("Jane Doe");
      expect(res.body.enabled).toBe(true);
      expect(typeof res.body.lastModified).toBe("string");
    });

    it("POST /users returns 409 on duplicate uid", async () => {
      const app = createAcmeHrApp({ store });
      await request(app).post("/users").send(SEED).expect(201);
      const dup = await request(app).post("/users").send(SEED);
      expect(dup.status).toBe(409);
    });

    it("GET /users/:uid returns the user", async () => {
      const app = createAcmeHrApp({ store });
      await request(app).post("/users").send(SEED).expect(201);
      const res = await request(app).get("/users/jdoe");
      expect(res.status).toBe(200);
      expect(res.body.uid).toBe("jdoe");
    });

    it("GET /users/:uid returns 404 for unknown uid", async () => {
      const app = createAcmeHrApp({ store });
      const res = await request(app).get("/users/nobody");
      expect(res.status).toBe(404);
    });

    it("PATCH /users/:uid flips enabled:false (the deactivation flow)", async () => {
      const app = createAcmeHrApp({ store });
      await request(app).post("/users").send(SEED).expect(201);
      const res = await request(app).patch("/users/jdoe").send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      // User remains in the store — PATCH, not DELETE.
      const getRes = await request(app).get("/users/jdoe");
      expect(getRes.status).toBe(200);
    });

    it("PATCH /users/:uid returns 404 for unknown uid", async () => {
      const app = createAcmeHrApp({ store });
      const res = await request(app).patch("/users/nobody").send({ enabled: false });
      expect(res.status).toBe(404);
    });

    it("GET /users lists all stored users", async () => {
      const app = createAcmeHrApp({ store });
      await request(app).post("/users").send(SEED).expect(201);
      await request(app)
        .post("/users")
        .send({ ...SEED, uid: "asmith", mail: "asmith@acme-hr.example.com", cn: "A Smith" })
        .expect(201);
      const res = await request(app).get("/users");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });
  });

  describe("bearer auth enabled", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const app = createAcmeHrApp({ store, apiToken: "acme-secret" });
      const res = await request(app).get("/users");
      expect(res.status).toBe(401);
    });

    it("accepts requests with the correct bearer token", async () => {
      const app = createAcmeHrApp({ store, apiToken: "acme-secret" });
      const res = await request(app).get("/users").set("Authorization", "Bearer acme-secret");
      expect(res.status).toBe(200);
    });

    it("rejects wrong-scheme Authorization header", async () => {
      const app = createAcmeHrApp({ store, apiToken: "acme-secret" });
      const res = await request(app).get("/users").set("Authorization", "Basic xxx");
      expect(res.status).toBe(401);
    });

    it("rejects wrong bearer token", async () => {
      const app = createAcmeHrApp({ store, apiToken: "acme-secret" });
      const res = await request(app).get("/users").set("Authorization", "Bearer wrong");
      expect(res.status).toBe(401);
    });

    it("enforces auth on POST /users", async () => {
      const app = createAcmeHrApp({ store, apiToken: "acme-secret" });
      const res = await request(app).post("/users").send(SEED);
      expect(res.status).toBe(401);
    });

    it("enforces auth on PATCH /users/:uid", async () => {
      const app = createAcmeHrApp({ store, apiToken: "acme-secret" });
      const res = await request(app).patch("/users/jdoe").send({ enabled: false });
      expect(res.status).toBe(401);
    });
  });
});
