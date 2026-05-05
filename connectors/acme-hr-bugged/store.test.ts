/**
 * Bugged-connector tests — the thing the demo uses to demonstrate the
 * gate-refusal flow at beats 6-8 of docs/demo-script.md.
 *
 * A real-world junior-consultant-forgot-active:false-handling bug,
 * captured in code. When SCIM PATCH active:false arrives, this connector
 * returns 200 with body.active=false but NEVER forwards the mutation to
 * AcmeHR. The target remains enabled=true. OIN SPEC Test step 7
 * (Deactivate User) fails against this connector because the external
 * state doesn't match the SCIM response.
 *
 * See docs/connector-laws.md §6 SMOKE-GREEN — this is the failure mode
 * that motivates step 3 of runSmoke (direct target read after PATCH).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { BuggyAcmeHrUserStore } from "./store.js";
import type { AcmeHrClient } from "../acme-hr/client.js";
import { AcmeHrApiError } from "../acme-hr/client.js";
import type { AcmeHrUser, AcmeHrUserCreate, AcmeHrUserPatch } from "../../demo-targets/acme-hr-lite/types.js";

const SCIM_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

class FakeAcmeHrClient implements AcmeHrClient {
  public users = new Map<string, AcmeHrUser>();

  async listUsers(): Promise<AcmeHrUser[]> {
    return [...this.users.values()];
  }
  async getUser(uid: string): Promise<AcmeHrUser | null> {
    return this.users.get(uid) ?? null;
  }
  async createUser(input: AcmeHrUserCreate): Promise<AcmeHrUser> {
    if (this.users.has(input.uid)) throw new AcmeHrApiError(409, { error: "uid_conflict" });
    const user: AcmeHrUser = { ...input, lastModified: new Date().toISOString() };
    this.users.set(user.uid, user);
    return user;
  }
  async patchUser(uid: string, patch: AcmeHrUserPatch): Promise<AcmeHrUser | null> {
    const existing = this.users.get(uid);
    if (!existing) return null;
    const updated: AcmeHrUser = { ...existing, ...patch, lastModified: new Date().toISOString() };
    this.users.set(uid, updated);
    return updated;
  }
}

describe("BuggyAcmeHrUserStore", () => {
  let client: FakeAcmeHrClient;
  let store: BuggyAcmeHrUserStore;

  beforeEach(() => {
    client = new FakeAcmeHrClient();
    store = new BuggyAcmeHrUserStore(client);
  });

  it("create still works normally — the bug is ONLY in patch", async () => {
    const stored = await store.create({
      schemas: [SCIM_SCHEMA],
      userName: "jdoe",
      emails: [{ value: "j@example.com", primary: true }],
      active: true,
    });
    expect(stored.id).toBe("jdoe");
    expect(client.users.has("jdoe")).toBe(true);
    expect(client.users.get("jdoe")?.enabled).toBe(true);
  });

  it("get still works normally — the bug is ONLY in patch", async () => {
    await store.create({
      schemas: [SCIM_SCHEMA],
      userName: "jdoe",
      emails: [{ value: "j@example.com", primary: true }],
      active: true,
    });
    const found = await store.get("jdoe");
    expect(found?.id).toBe("jdoe");
  });

  it("BUG: PATCH active:false returns body.active=false, but AcmeHR row stays enabled=true", async () => {
    await store.create({
      schemas: [SCIM_SCHEMA],
      userName: "jdoe",
      emails: [{ value: "j@example.com", primary: true }],
      active: true,
    });

    const result = await store.patch("jdoe", [{ op: "replace", value: { active: false } }]);

    // The SCIM response LOOKS correct — body says active=false, status would be 200.
    // This is how the bug ships to prod undetected by tests that only verify the
    // SCIM response.
    expect(result).not.toBeNull();
    expect(result?.active).toBe(false);

    // But AcmeHR's actual state was never mutated. The user is still enabled.
    // This is the divergence that gate-refusal catches — the OIN SPEC Test
    // step 7 + the smoke runner step 3 (target-verify-deactivated) detect
    // this exact discrepancy.
    const backing = client.users.get("jdoe");
    expect(backing?.enabled).toBe(true);
  });

  it("PATCH returns null for unknown uid — this behavior is NOT bugged", async () => {
    const result = await store.patch("nobody", [{ op: "replace", value: { active: false } }]);
    expect(result).toBeNull();
  });

  it("list still works normally", async () => {
    await store.create({
      schemas: [SCIM_SCHEMA],
      userName: "a",
      emails: [{ value: "a@example.com", primary: true }],
      active: true,
    });
    await store.create({
      schemas: [SCIM_SCHEMA],
      userName: "b",
      emails: [{ value: "b@example.com", primary: true }],
      active: true,
    });
    const result = await store.list({ startIndex: 1, count: 100 });
    expect(result.total).toBe(2);
  });
});
