/**
 * SCIM compliance validator tests — post-deploy check that a running
 * connector's /ServiceProviderConfig advertises what the ticket template
 * required.
 *
 * This IS the Day-8 validator call-site per the 10-day plan. Catches the
 * case where an agent generates a connector that claims to support X but
 * advertises ¬X at its metadata endpoint — Okta sees the ¬X claim and
 * refuses to exercise the feature, so the OIN SPEC Tests never catch it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../skeleton/server.js";
import { InMemoryUserStore } from "../../skeleton/store/user-store.js";
import { validateScimCompliance } from "./scim-compliance.js";

interface Handle {
  server: Server;
  url: string;
}

async function bootSkeleton(): Promise<Handle> {
  const app = createApp({ userStore: new InMemoryUserStore() });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url };
}

async function shutdown(h: Handle): Promise<void> {
  await new Promise<void>((r) => h.server.close(() => r()));
}

describe("validateScimCompliance", () => {
  let h: Handle;

  beforeEach(async () => {
    h = await bootSkeleton();
  });

  afterEach(async () => {
    await shutdown(h);
  });

  it("passes when the connector advertises patch + filter (skeleton defaults)", async () => {
    const result = await validateScimCompliance({
      connectorUrl: h.url,
      requiredOps: {
        users_create: true,
        users_read: true,
        users_update_patch: true,
        users_list: true,
        users_filter: true,
        users_delete: false,
        groups: false,
        group_push: false,
        group_members_patch: false,
      },
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("fails with a specific error when ticket requires patch but SPC says patch.supported=false", async () => {
    // We can't easily mutate the live skeleton's ServiceProviderConfig —
    // simulate by pointing the validator at a mocked URL. Use a data URL
    // via fetchImpl override instead.
    const result = await validateScimCompliance({
      connectorUrl: "http://not-used",
      requiredOps: {
        users_create: true,
        users_read: true,
        users_update_patch: true,
        users_list: true,
        users_filter: true,
        users_delete: false,
        groups: false,
        group_push: false,
        group_members_patch: false,
      },
      fetchImpl: async () => new Response(JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
        patch: { supported: false },
        filter: { supported: true, maxResults: 100 },
        bulk: { supported: false },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [],
      }), { status: 200, headers: { "content-type": "application/scim+json" } }),
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ check: "patch.supported" }),
    );
  });

  it("fails when ticket requires filter but SPC says filter.supported=false", async () => {
    const result = await validateScimCompliance({
      connectorUrl: "http://not-used",
      requiredOps: {
        users_create: true,
        users_read: true,
        users_update_patch: true,
        users_list: true,
        users_filter: true,
        users_delete: false,
        groups: false,
        group_push: false,
        group_members_patch: false,
      },
      fetchImpl: async () => new Response(JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
        patch: { supported: true },
        filter: { supported: false, maxResults: 0 },
      }), { status: 200, headers: { "content-type": "application/scim+json" } }),
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ check: "filter.supported" }),
    );
  });

  it("fails when /ServiceProviderConfig is unreachable", async () => {
    const result = await validateScimCompliance({
      connectorUrl: "http://127.0.0.1:1", // refused immediately
      requiredOps: {
        users_create: true,
        users_read: true,
        users_update_patch: true,
        users_list: true,
        users_filter: true,
        users_delete: false,
        groups: false,
        group_push: false,
        group_members_patch: false,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ check: "serviceproviderconfig.reachable" }),
    );
  });

  it("fails when /ServiceProviderConfig returns wrong content-type", async () => {
    const result = await validateScimCompliance({
      connectorUrl: "http://not-used",
      requiredOps: {
        users_create: true,
        users_read: true,
        users_update_patch: true,
        users_list: true,
        users_filter: true,
        users_delete: false,
        groups: false,
        group_push: false,
        group_members_patch: false,
      },
      fetchImpl: async () => new Response(JSON.stringify({ patch: { supported: true }, filter: { supported: true } }), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ check: "serviceproviderconfig.content_type" }),
    );
  });

  it("passes when groups is not required and SPC advertises nothing about groups (silence is OK)", async () => {
    const result = await validateScimCompliance({
      connectorUrl: h.url,
      requiredOps: {
        users_create: true,
        users_read: true,
        users_update_patch: true,
        users_list: true,
        users_filter: true,
        users_delete: false,
        groups: false,
        group_push: false,
        group_members_patch: false,
      },
    });
    expect(result.ok).toBe(true);
  });
});
