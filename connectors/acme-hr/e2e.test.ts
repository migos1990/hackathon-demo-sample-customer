/**
 * End-to-end wire test: SCIM in (against the connector) → AcmeHR out
 * (landing in the real target-app HTTP API). Two real Express apps on
 * two ephemeral ports, connected by a real fetch client. No mocks,
 * no stubs.
 *
 * This is the shot-5 dataflow from docs/demo-script.md in miniature.
 * The video captures the real AcmeHR admin UI; this test verifies the
 * mechanism the UI observes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAcmeHrApp } from "../../demo-targets/acme-hr-lite/server.js";
import { InMemoryAcmeHrStore } from "../../demo-targets/acme-hr-lite/store.js";
import { createAcmeHrConnector } from "./server.js";

async function bootAcmeHr(): Promise<{
  store: InMemoryAcmeHrStore;
  server: Server;
  baseUrl: string;
}> {
  const store = new InMemoryAcmeHrStore();
  const app = createAcmeHrApp({ store });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address() as AddressInfo;
  return { store, server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function shutdown(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("AcmeHR connector — end to end (SCIM in, AcmeHR out)", () => {
  let acmeHr: { store: InMemoryAcmeHrStore; server: Server; baseUrl: string };

  beforeEach(async () => {
    acmeHr = await bootAcmeHr();
  });

  afterEach(async () => {
    await shutdown(acmeHr.server);
  });

  it("SCIM POST /Users provisions the user in AcmeHR (demo shot 5 dataflow)", async () => {
    const connector = createAcmeHrConnector({ targetBaseUrl: acmeHr.baseUrl });

    const scimPayload = {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "jdoe",
      name: { givenName: "Jane", familyName: "Doe", formatted: "Jane Doe" },
      emails: [{ value: "jdoe@acme-hr.example.com", primary: true, type: "work" }],
      active: true,
    };

    const res = await request(connector)
      .post("/scim/v2/Users")
      .set("content-type", "application/json")
      .send(scimPayload);

    expect(res.status).toBe(201);
    expect(res.headers["content-type"]).toMatch(/^application\/scim\+json/);
    expect(res.body.userName).toBe("jdoe");
    expect(res.body.id).toBe("jdoe"); // uid doubles as SCIM id

    // Assert the user actually landed in AcmeHR's native store.
    const backingUser = acmeHr.store.get("jdoe");
    expect(backingUser).not.toBeNull();
    expect(backingUser?.uid).toBe("jdoe");
    expect(backingUser?.cn).toBe("Jane Doe");
    expect(backingUser?.mail).toBe("jdoe@acme-hr.example.com");
    expect(backingUser?.enabled).toBe(true);
  });

  it("SCIM PATCH active:false deactivates in AcmeHR (OIN step 7 + demo gate-refusal beat)", async () => {
    const connector = createAcmeHrConnector({ targetBaseUrl: acmeHr.baseUrl });

    // Create first.
    await request(connector)
      .post("/scim/v2/Users")
      .set("content-type", "application/json")
      .send({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "jdoe",
        emails: [{ value: "jdoe@example.com", primary: true }],
        active: true,
      })
      .expect(201);

    // PATCH active:false — the deactivation flow the OIN SPEC tests assert.
    const res = await request(connector)
      .patch("/scim/v2/Users/jdoe")
      .set("content-type", "application/json")
      .send({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", value: { active: false } }],
      });

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);

    // AcmeHR row is DEACTIVATED (enabled=false), NOT deleted.
    const backing = acmeHr.store.get("jdoe");
    expect(backing).not.toBeNull();
    expect(backing?.enabled).toBe(false);
  });

  it("SCIM GET /Users?filter=userName eq '...' queries AcmeHR and filters case-sensitively", async () => {
    const connector = createAcmeHrConnector({ targetBaseUrl: acmeHr.baseUrl });

    // Seed via the connector itself to exercise the full wire.
    for (const uid of ["user-001", "user-002", "user-003"]) {
      await request(connector)
        .post("/scim/v2/Users")
        .set("content-type", "application/json")
        .send({
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: uid,
          emails: [{ value: `${uid}@example.com`, primary: true }],
          active: true,
        })
        .expect(201);
    }

    const hit = await request(connector)
      .get("/scim/v2/Users")
      .query({ filter: 'userName eq "user-002"' });
    expect(hit.status).toBe(200);
    expect(hit.body.totalResults).toBe(1);
    expect(hit.body.Resources[0].id).toBe("user-002");

    // OIN step 16 — case-sensitivity.
    const miss = await request(connector)
      .get("/scim/v2/Users")
      .query({ filter: 'userName eq "USER-002"' });
    expect(miss.status).toBe(200);
    expect(miss.body.totalResults).toBe(0);
  });

  it("SCIM POST /Users on a duplicate userName returns 409 + scimType:uniqueness", async () => {
    const connector = createAcmeHrConnector({ targetBaseUrl: acmeHr.baseUrl });

    const payload = {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "jdoe",
      emails: [{ value: "jdoe@example.com", primary: true }],
      active: true,
    };

    await request(connector).post("/scim/v2/Users").send(payload).expect(201);
    const dup = await request(connector).post("/scim/v2/Users").send(payload);
    expect(dup.status).toBe(409);
    expect(dup.body.scimType).toBe("uniqueness");
  });

  it("SCIM GET /Users/:id returns 404 when the user does not exist in AcmeHR", async () => {
    const connector = createAcmeHrConnector({ targetBaseUrl: acmeHr.baseUrl });
    const res = await request(connector).get("/scim/v2/Users/nobody");
    expect(res.status).toBe(404);
  });
});
