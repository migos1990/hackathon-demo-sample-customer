import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createAcmeHrApp } from "../server.js";
import { InMemoryAcmeHrStore } from "../store.js";

describe("AcmeHR-lite /admin HTML", () => {
  let store: InMemoryAcmeHrStore;

  beforeEach(() => {
    store = new InMemoryAcmeHrStore();
  });

  it("returns 200 with text/html", async () => {
    const app = createAcmeHrApp({ store });
    const res = await request(app).get("/admin");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
  });

  it("renders users in the page body", async () => {
    store.create({
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
    });
    const app = createAcmeHrApp({ store });
    const res = await request(app).get("/admin");
    // The uid + cn + mail should be visible in the rendered page — that's
    // what the demo shot 5 shows landing in real time.
    expect(res.text).toContain("jdoe");
    expect(res.text).toContain("Jane Doe");
    expect(res.text).toContain("jdoe@acme-hr.example.com");
  });

  it("shows empty-state message when no users exist", async () => {
    const app = createAcmeHrApp({ store });
    const res = await request(app).get("/admin");
    expect(res.text.toLowerCase()).toMatch(/no users/);
  });

  it("includes meta refresh so the page auto-polls (visible provisioning)", async () => {
    const app = createAcmeHrApp({ store });
    const res = await request(app).get("/admin");
    // <meta http-equiv="refresh" content="..."> drives the "users appear live"
    // demo moment. HTML meta refresh avoids any JS dep.
    expect(res.text).toMatch(/<meta\s+http-equiv="refresh"/i);
  });

  it("renders enabled=false rows visually distinct (deactivated styling)", async () => {
    store.create({
      uid: "exuser",
      cn: "Ex User",
      givenName: "Ex",
      sn: "User",
      mail: "ex@acme-hr.example.com",
      employeeNumber: null,
      title: null,
      department: null,
      enabled: false,
      memberOf: [],
    });
    const app = createAcmeHrApp({ store });
    const res = await request(app).get("/admin");
    // Deactivated rows carry a data attribute or class so CSS can style them.
    // Gate on presence of the hook — doesn't pin the exact CSS.
    expect(res.text).toMatch(/data-enabled="false"|class="[^"]*deactivated/);
  });

  it("admin page is auth-exempt even when apiToken is set (demo needs visible UI)", async () => {
    // AcmeHR-lite is a mock — the admin view is for judging eyeballs, not
    // end-user access. Skipping auth here mirrors how real admin panels sit
    // behind IdP + VPN, not bearer tokens. For the demo, the video captures
    // this page; requiring a token just to show it adds zero value.
    const app = createAcmeHrApp({ store, apiToken: "acme-secret" });
    const res = await request(app).get("/admin");
    expect(res.status).toBe(200);
  });
});
