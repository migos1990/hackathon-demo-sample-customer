/**
 * HTTP client tests — boot a real AcmeHR-lite app on an ephemeral port,
 * round-trip against it with fetch. No mocks.
 *
 * This is the integration boundary between the SCIM connector (the thing
 * the agent generates) and the customer's target-app API. Getting the
 * wire behavior right here is a direct contributor to OIN passage —
 * silent errors on this boundary are how real-world integrations fail
 * the SPEC Tests in production.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createAcmeHrApp } from "../../demo-targets/acme-hr-lite/server.js";
import { InMemoryAcmeHrStore } from "../../demo-targets/acme-hr-lite/store.js";
import { HttpAcmeHrClient, AcmeHrApiError } from "./client.js";

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
  memberOf: [],
};

async function bootApp(options: { apiToken?: string } = {}): Promise<{
  store: InMemoryAcmeHrStore;
  server: Server;
  baseUrl: string;
}> {
  const store = new InMemoryAcmeHrStore();
  const app = createAcmeHrApp({ store, ...(options.apiToken && { apiToken: options.apiToken }) });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address() as AddressInfo;
  return { store, server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function shutdown(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("HttpAcmeHrClient — real HTTP round-trips", () => {
  let handle: { store: InMemoryAcmeHrStore; server: Server; baseUrl: string };

  beforeEach(async () => {
    handle = await bootApp();
  });

  afterEach(async () => {
    await shutdown(handle.server);
  });

  it("listUsers returns [] when the store is empty", async () => {
    const client = new HttpAcmeHrClient({ baseUrl: handle.baseUrl });
    expect(await client.listUsers()).toEqual([]);
  });

  it("createUser POSTs and returns the stored user (201)", async () => {
    const client = new HttpAcmeHrClient({ baseUrl: handle.baseUrl });
    const created = await client.createUser(SEED);
    expect(created.uid).toBe("jdoe");
    expect(typeof created.lastModified).toBe("string");
  });

  it("createUser throws AcmeHrApiError with status 409 on duplicate uid", async () => {
    const client = new HttpAcmeHrClient({ baseUrl: handle.baseUrl });
    await client.createUser(SEED);
    try {
      await client.createUser(SEED);
      expect.fail("expected AcmeHrApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(AcmeHrApiError);
      expect((err as AcmeHrApiError).status).toBe(409);
    }
  });

  it("getUser returns the user on 200", async () => {
    const client = new HttpAcmeHrClient({ baseUrl: handle.baseUrl });
    await client.createUser(SEED);
    const found = await client.getUser("jdoe");
    expect(found?.uid).toBe("jdoe");
  });

  it("getUser returns null on 404 (per interface contract)", async () => {
    const client = new HttpAcmeHrClient({ baseUrl: handle.baseUrl });
    expect(await client.getUser("nobody")).toBeNull();
  });

  it("patchUser applies enabled:false and returns the updated user", async () => {
    const client = new HttpAcmeHrClient({ baseUrl: handle.baseUrl });
    await client.createUser(SEED);
    const updated = await client.patchUser("jdoe", { enabled: false });
    expect(updated?.enabled).toBe(false);
  });

  it("patchUser returns null on 404", async () => {
    const client = new HttpAcmeHrClient({ baseUrl: handle.baseUrl });
    expect(await client.patchUser("nobody", { enabled: false })).toBeNull();
  });

  it("listUsers returns multiple users in insertion order", async () => {
    const client = new HttpAcmeHrClient({ baseUrl: handle.baseUrl });
    await client.createUser(SEED);
    await client.createUser({ ...SEED, uid: "asmith", cn: "A Smith", mail: "a@example.com" });
    const all = await client.listUsers();
    expect(all.map((u) => u.uid)).toEqual(["jdoe", "asmith"]);
  });
});

describe("HttpAcmeHrClient — bearer auth", () => {
  let handle: { store: InMemoryAcmeHrStore; server: Server; baseUrl: string };

  beforeEach(async () => {
    handle = await bootApp({ apiToken: "acme-secret" });
  });

  afterEach(async () => {
    await shutdown(handle.server);
  });

  it("attaches Authorization: Bearer <token> when apiToken is configured", async () => {
    const client = new HttpAcmeHrClient({ baseUrl: handle.baseUrl, apiToken: "acme-secret" });
    expect(await client.listUsers()).toEqual([]);
  });

  it("throws 401 when apiToken mismatches the server's", async () => {
    const client = new HttpAcmeHrClient({ baseUrl: handle.baseUrl, apiToken: "wrong" });
    try {
      await client.listUsers();
      expect.fail("expected 401");
    } catch (err) {
      expect(err).toBeInstanceOf(AcmeHrApiError);
      expect((err as AcmeHrApiError).status).toBe(401);
    }
  });

  it("throws 401 when apiToken is absent on a server that requires it", async () => {
    const client = new HttpAcmeHrClient({ baseUrl: handle.baseUrl });
    try {
      await client.listUsers();
      expect.fail("expected 401");
    } catch (err) {
      expect((err as AcmeHrApiError).status).toBe(401);
    }
  });
});
