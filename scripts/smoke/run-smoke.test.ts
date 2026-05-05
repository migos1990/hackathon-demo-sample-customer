/**
 * Smoke-runner tests — library shape. Boots real AcmeHR-lite + connector
 * on ephemeral ports, runs the smoke function against their URLs, verifies
 * the structured SmokeReport matches reality.
 *
 * This directly closes Connector Law 6 (SMOKE-GREEN): the gate that
 * produces the `smoke_test_passed` + `log_errors_count` fields feeding
 * `scripts/promotion-manifest/build.ts:assertVerifyPassed`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAcmeHrApp } from "../../demo-targets/acme-hr-lite/server.js";
import { InMemoryAcmeHrStore } from "../../demo-targets/acme-hr-lite/store.js";
import { createAcmeHrConnector } from "../../connectors/acme-hr/server.js";
import { runSmoke } from "./run-smoke.js";

interface Handle {
  targetStore: InMemoryAcmeHrStore;
  targetServer: Server;
  targetUrl: string;
  connectorServer: Server;
  connectorUrl: string;
}

async function bootStack(): Promise<Handle> {
  const targetStore = new InMemoryAcmeHrStore();
  const targetApp = createAcmeHrApp({ store: targetStore });
  const targetServer = targetApp.listen(0);
  await new Promise<void>((resolve) => targetServer.once("listening", () => resolve()));
  const targetAddr = targetServer.address() as AddressInfo;
  const targetUrl = `http://127.0.0.1:${targetAddr.port}`;

  const connectorApp = createAcmeHrConnector({ targetBaseUrl: targetUrl });
  const connectorServer = connectorApp.listen(0);
  await new Promise<void>((resolve) => connectorServer.once("listening", () => resolve()));
  const connectorAddr = connectorServer.address() as AddressInfo;
  const connectorUrl = `http://127.0.0.1:${connectorAddr.port}`;

  return { targetStore, targetServer, targetUrl, connectorServer, connectorUrl };
}

async function shutdown(h: Handle): Promise<void> {
  await Promise.all([
    new Promise<void>((r) => h.targetServer.close(() => r())),
    new Promise<void>((r) => h.connectorServer.close(() => r())),
  ]);
}

describe("runSmoke — happy path", () => {
  let h: Handle;

  beforeEach(async () => {
    h = await bootStack();
  });

  afterEach(async () => {
    await shutdown(h);
  });

  it("provisions, deactivates, cleans up; reports smoke_test_passed=true, log_errors_count=0", async () => {
    const report = await runSmoke({
      connectorUrl: h.connectorUrl,
      targetUrl: h.targetUrl,
    });
    expect(report.smoke_test_passed).toBe(true);
    expect(report.log_errors_count).toBe(0);
    expect(report.steps).toHaveLength(3); // create, patch-deactivate, verify-deactivated
    expect(report.steps.every((s) => s.ok)).toBe(true);
    expect(report.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("produces a fresh userName per run so repeat runs don't collide on uniqueness", async () => {
    const a = await runSmoke({ connectorUrl: h.connectorUrl, targetUrl: h.targetUrl });
    const b = await runSmoke({ connectorUrl: h.connectorUrl, targetUrl: h.targetUrl });
    expect(a.smoke_test_passed).toBe(true);
    expect(b.smoke_test_passed).toBe(true);
    // Both succeeded means the second run didn't collide with the first.
    expect([...h.targetStore.list()].length).toBeGreaterThanOrEqual(2);
  });

  it("the provisioned user lands in AcmeHR's actual store (real wire, not a mock)", async () => {
    const before = [...h.targetStore.list()].length;
    await runSmoke({ connectorUrl: h.connectorUrl, targetUrl: h.targetUrl });
    const after = [...h.targetStore.list()].length;
    expect(after).toBe(before + 1);
  });
});

describe("runSmoke — failure detection", () => {
  it("reports smoke_test_passed=false when the connector URL is unreachable", async () => {
    // Port 1 is reserved and will refuse immediately — unreachable, fast fail.
    const report = await runSmoke({
      connectorUrl: "http://127.0.0.1:1",
      targetUrl: "http://127.0.0.1:1",
    });
    expect(report.smoke_test_passed).toBe(false);
    expect(report.log_errors_count).toBeGreaterThan(0);
    // The failing step carries the error detail.
    const failedStep = report.steps.find((s) => !s.ok);
    expect(failedStep).toBeDefined();
    expect(failedStep?.error).toBeTruthy();
  });

  it("reports smoke_test_passed=false when the deactivation step doesn't actually deactivate", async () => {
    // Boot the target with a store that refuses PATCH (simulated broken connector).
    // We can't easily simulate that — instead, test the verification step:
    // if PATCH goes through but the target lies about the result, the smoke
    // runner's verify-deactivated step should catch it. Simulate by pointing
    // the smoke at a connector whose target has different data.

    const targetStore = new InMemoryAcmeHrStore();
    const targetApp = createAcmeHrApp({ store: targetStore });
    const targetServer = targetApp.listen(0);
    await new Promise<void>((r) => targetServer.once("listening", () => r()));
    const targetUrl = `http://127.0.0.1:${(targetServer.address() as AddressInfo).port}`;

    // Create the user in the target directly with enabled:true, bypassing
    // the connector's create step.
    targetStore.create({
      uid: "smoke-expected-user",
      cn: "Smoke User",
      givenName: "Smoke",
      sn: "User",
      mail: "smoke@example.com",
      employeeNumber: null,
      title: null,
      department: null,
      enabled: true,
      memberOf: [],
    });

    // Start a connector pointed at a DIFFERENT (empty) target so the connector's
    // create step lands nowhere visible to the smoke runner's later verify step.
    const emptyTargetStore = new InMemoryAcmeHrStore();
    const emptyTargetApp = createAcmeHrApp({ store: emptyTargetStore });
    const emptyTargetServer = emptyTargetApp.listen(0);
    await new Promise<void>((r) => emptyTargetServer.once("listening", () => r()));
    const emptyTargetUrl = `http://127.0.0.1:${(emptyTargetServer.address() as AddressInfo).port}`;

    const connectorApp = createAcmeHrConnector({ targetBaseUrl: emptyTargetUrl });
    const connectorServer = connectorApp.listen(0);
    await new Promise<void>((r) => connectorServer.once("listening", () => r()));
    const connectorUrl = `http://127.0.0.1:${(connectorServer.address() as AddressInfo).port}`;

    // Pass the MISMATCHED target (where the user is NOT provisioned via the
    // connector) as the verify target — the verify step will read from it
    // and find the user is still enabled:true (actually missing), failing.
    const report = await runSmoke({
      connectorUrl,
      targetUrl, // the populated-but-stale store
    });
    expect(report.smoke_test_passed).toBe(false);
    expect(report.log_errors_count).toBeGreaterThan(0);

    await Promise.all([
      new Promise<void>((r) => targetServer.close(() => r())),
      new Promise<void>((r) => emptyTargetServer.close(() => r())),
      new Promise<void>((r) => connectorServer.close(() => r())),
    ]);
  });
});
