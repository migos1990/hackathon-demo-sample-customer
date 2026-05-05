/**
 * AcmeHrUserStore tests — unit-scope using a fake AcmeHrClient backed by
 * an in-memory map. Keeps tests fast; the wire behavior is covered in
 * client.test.ts, and e2e.test.ts covers the full stack-top-to-bottom.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AcmeHrUserStore } from "./store.js";
import type { AcmeHrClient } from "./client.js";
import { AcmeHrApiError } from "./client.js";
import type { AcmeHrUser, AcmeHrUserCreate, AcmeHrUserPatch } from "../../demo-targets/acme-hr-lite/types.js";
import { UserNameConflictError } from "../../skeleton/store/user-store.js";

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
    if (this.users.has(input.uid)) {
      throw new AcmeHrApiError(409, { error: "uid_conflict" });
    }
    const user: AcmeHrUser = { ...input, lastModified: new Date().toISOString() };
    this.users.set(user.uid, user);
    return user;
  }
  async patchUser(uid: string, patch: AcmeHrUserPatch): Promise<AcmeHrUser | null> {
    const existing = this.users.get(uid);
    if (!existing) return null;
    const updated: AcmeHrUser = {
      ...existing,
      ...patch,
      lastModified: new Date().toISOString(),
    };
    this.users.set(uid, updated);
    return updated;
  }
}

describe("AcmeHrUserStore", () => {
  let client: FakeAcmeHrClient;
  let store: AcmeHrUserStore;

  beforeEach(() => {
    client = new FakeAcmeHrClient();
    store = new AcmeHrUserStore(client);
  });

  describe("create", () => {
    it("creates the backing AcmeHR user and returns a SCIM-shaped StoredUser", async () => {
      const stored = await store.create({
        schemas: [SCIM_SCHEMA],
        userName: "jdoe",
        name: { givenName: "Jane", familyName: "Doe" },
        emails: [{ value: "jdoe@example.com", primary: true }],
        active: true,
      });
      // uid doubles as SCIM id (LDAP-backed SCIM convention).
      expect(stored.id).toBe("jdoe");
      expect(stored.userName).toBe("jdoe");
      expect(stored.active).toBe(true);
      expect(stored.meta.resourceType).toBe("User");
      // Side effect: client has the user.
      expect(client.users.has("jdoe")).toBe(true);
    });

    it("translates 409 from AcmeHR into UserNameConflictError (caller maps to 409+uniqueness)", async () => {
      await store.create({
        schemas: [SCIM_SCHEMA],
        userName: "jdoe",
        emails: [{ value: "a@example.com", primary: true }],
        active: true,
      });
      await expect(
        store.create({
          schemas: [SCIM_SCHEMA],
          userName: "jdoe",
          emails: [{ value: "b@example.com", primary: true }],
          active: true,
        }),
      ).rejects.toThrow(UserNameConflictError);
    });
  });

  describe("get", () => {
    it("returns the StoredUser when uid exists", async () => {
      await store.create({
        schemas: [SCIM_SCHEMA],
        userName: "jdoe",
        emails: [{ value: "j@example.com", primary: true }],
        active: true,
      });
      const found = await store.get("jdoe");
      expect(found?.id).toBe("jdoe");
    });

    it("returns null for unknown uid", async () => {
      expect(await store.get("nobody")).toBeNull();
    });
  });

  describe("list", () => {
    beforeEach(async () => {
      // Seed 4 users: three active + one inactive for the filter tests.
      for (const uid of ["user-001", "user-002", "user-003", "user-004"]) {
        await store.create({
          schemas: [SCIM_SCHEMA],
          userName: uid,
          emails: [{ value: `${uid}@example.com`, primary: true }],
          active: uid !== "user-003", // user-003 deactivated
        });
      }
    });

    it("returns all users with correct total when no filter", async () => {
      const result = await store.list({ startIndex: 1, count: 100 });
      expect(result.total).toBe(4);
      expect(result.resources).toHaveLength(4);
    });

    it("filters by userName eq exactly (OIN step 16 case-sensitive semantics)", async () => {
      const result = await store.list({
        startIndex: 1,
        count: 100,
        filter: 'userName eq "user-003"',
      });
      expect(result.total).toBe(1);
      expect(result.resources[0]?.id).toBe("user-003");
    });

    it("case-sensitive match returns 0 on uppercase variant (OIN step 16)", async () => {
      const result = await store.list({
        startIndex: 1,
        count: 100,
        filter: 'userName eq "USER-003"',
      });
      expect(result.total).toBe(0);
    });

    it("paginates via startIndex + count (1-based per RFC 7644 §3.4.2.4)", async () => {
      const page1 = await store.list({ startIndex: 1, count: 2 });
      const page2 = await store.list({ startIndex: 3, count: 2 });
      expect(page1.resources).toHaveLength(2);
      expect(page2.resources).toHaveLength(2);
      expect(page1.resources[0]?.id).not.toBe(page2.resources[0]?.id);
      expect(page1.total).toBe(4);
    });
  });

  describe("patch", () => {
    it("translates SCIM replace active:false → AcmeHR enabled:false (the deactivation flow)", async () => {
      await store.create({
        schemas: [SCIM_SCHEMA],
        userName: "jdoe",
        emails: [{ value: "j@example.com", primary: true }],
        active: true,
      });
      const updated = await store.patch("jdoe", [{ op: "replace", value: { active: false } }]);
      expect(updated?.active).toBe(false);
      // Backing AcmeHR row flipped.
      expect(client.users.get("jdoe")?.enabled).toBe(false);
    });

    it("translates path-based name.givenName replace", async () => {
      await store.create({
        schemas: [SCIM_SCHEMA],
        userName: "jdoe",
        name: { givenName: "Jane", familyName: "Doe" },
        emails: [{ value: "j@example.com", primary: true }],
        active: true,
      });
      const updated = await store.patch("jdoe", [
        { op: "replace", path: "name.givenName", value: "Janet" },
      ]);
      expect(updated?.name?.givenName).toBe("Janet");
      expect(client.users.get("jdoe")?.givenName).toBe("Janet");
    });

    it("returns null on unknown uid (caller maps to 404)", async () => {
      const result = await store.patch("nobody", [{ op: "replace", value: { active: false } }]);
      expect(result).toBeNull();
    });

    it("applies multi-op PATCH atomically", async () => {
      await store.create({
        schemas: [SCIM_SCHEMA],
        userName: "jdoe",
        name: { givenName: "Jane", familyName: "Doe" },
        emails: [{ value: "j@example.com", primary: true }],
        active: true,
      });
      const updated = await store.patch("jdoe", [
        { op: "replace", value: { active: false } },
        { op: "replace", path: "name.givenName", value: "Janet" },
      ]);
      expect(updated?.active).toBe(false);
      expect(updated?.name?.givenName).toBe("Janet");
    });
  });
});
