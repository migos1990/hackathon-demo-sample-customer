/**
 * Gate-refusal integration test — the demo beat 6-8 proof.
 *
 * Boots the bugged connector + real AcmeHR-lite, runs the smoke runner
 * against them, verifies smoke_test_passed === false and step 3 is the
 * failing step. This is what the video captures: promotion refused.
 *
 * Companion to connectors/acme-hr/e2e.test.ts (which proves the HAPPY
 * path works). Together these two tests are the demo's truth anchor:
 * we have two real connectors, one correct and one broken, and the
 * harness's gates distinguish them.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { createAcmeHrApp } from "../../demo-targets/acme-hr-lite/server.js";
import { InMemoryAcmeHrStore } from "../../demo-targets/acme-hr-lite/store.js";
import { createBuggedAcmeHrConnector } from "./server.js";
import { runSmoke } from "../../scripts/smoke/run-smoke.js";

interface Handle {
  targetStore: InMemoryAcmeHrStore;
  targetServer: Server;
  targetUrl: string;
  connectorServer: Server;
  connectorUrl: string;
}

async function bootBuggedStack(): Promise<Handle> {
  const targetStore = new InMemoryAcmeHrStore();
  const targetApp = createAcmeHrApp({ store: targetStore });
  const targetServer = targetApp.listen(0);
  await new Promise<void>((r) => targetServer.once("listening", () => r()));
  const targetUrl = `http://127.0.0.1:${(targetServer.address() as AddressInfo).port}`;

  const connectorApp = createBuggedAcmeHrConnector({ targetBaseUrl: targetUrl });
  const connectorServer = connectorApp.listen(0);
  await new Promise<void>((r) => connectorServer.once("listening", () => r()));
  const connectorUrl = `http://127.0.0.1:${(connectorServer.address() as AddressInfo).port}`;

  return { targetStore, targetServer, targetUrl, connectorServer, connectorUrl };
}

async function shutdown(h: Handle): Promise<void> {
  await Promise.all([
    new Promise<void>((r) => h.targetServer.close(() => r())),
    new Promise<void>((r) => h.connectorServer.close(() => r())),
  ]);
}

describe("Gate-refusal — bugged connector + smoke runner", () => {
  let h: Handle;

  beforeEach(async () => {
    h = await bootBuggedStack();
  });

  afterEach(async () => {
    await shutdown(h);
  });

  it("SCIM POST still succeeds — the bug is scoped to PATCH", async () => {
    const res = await request(h.connectorServer)
      .post("/scim/v2/Users")
      .set("content-type", "application/json")
      .send({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "jdoe",
        emails: [{ value: "j@example.com", primary: true }],
        active: true,
      });
    expect(res.status).toBe(201);
    // Provisioning worked — user is in the target.
    expect(h.targetStore.get("jdoe")?.enabled).toBe(true);
  });

  it("SCIM PATCH active:false returns 200 + body.active=false (the lie)", async () => {
    await request(h.connectorServer)
      .post("/scim/v2/Users")
      .send({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "jdoe",
        emails: [{ value: "j@example.com", primary: true }],
        active: true,
      })
      .expect(201);

    const res = await request(h.connectorServer)
      .patch("/scim/v2/Users/jdoe")
      .set("content-type", "application/json")
      .send({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", value: { active: false } }],
      });

    // SCIM thinks it worked. Status 200, body claims active=false.
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);

    // But AcmeHR's actual state still shows enabled=true.
    expect(h.targetStore.get("jdoe")?.enabled).toBe(true);
  });

  it("runSmoke detects the bug — smoke_test_passed=false, step 3 fails", async () => {
    const report = await runSmoke({
      connectorUrl: h.connectorUrl,
      targetUrl: h.targetUrl,
    });

    // This is the gate refusal. buildManifest will refuse to construct
    // a Promotion Manifest for this connector; promotion cannot proceed.
    expect(report.smoke_test_passed).toBe(false);
    expect(report.log_errors_count).toBeGreaterThan(0);

    // Steps 1 and 2 appear to pass — the connector lies convincingly
    // at the SCIM boundary. Step 3 reads the TARGET directly and
    // catches the divergence.
    const provisionStep = report.steps.find((s) => s.name === "scim-provision");
    const deactivateStep = report.steps.find((s) => s.name === "scim-patch-deactivate");
    const verifyStep = report.steps.find((s) => s.name === "target-verify-deactivated");
    expect(provisionStep?.ok).toBe(true);
    expect(deactivateStep?.ok).toBe(true);
    expect(verifyStep?.ok).toBe(false);
    expect(verifyStep?.error).toMatch(/enabled=true/);
  });
});
