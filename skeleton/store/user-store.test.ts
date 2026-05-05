import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryUserStore } from "./user-store.js";
import type { ScimUser } from "../types.js";

describe("InMemoryUserStore", () => {
  let store: InMemoryUserStore;

  beforeEach(() => {
    store = new InMemoryUserStore();
  });

  describe("create", () => {
    it("assigns a server-generated id and meta fields per RFC 7643 §3.1", async () => {
      const input: Omit<ScimUser, "id" | "meta"> = {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "user-001@example.com",
        name: { givenName: "User", familyName: "One" },
        emails: [{ primary: true, value: "user-001@example.com", type: "work" }],
        active: true,
      };

      const created = await store.create(input);

      expect(created.id).toBeDefined();
      expect(created.id).not.toBe("");
      expect(created.meta).toBeDefined();
      expect(created.meta?.resourceType).toBe("User");
      expect(created.meta?.created).toBeDefined();
      expect(created.meta?.lastModified).toBeDefined();
      expect(created.userName).toBe(input.userName);
    });

    it("rejects duplicate userName with a recognizable error (for 409+scimType:uniqueness mapping)", async () => {
      const a: Omit<ScimUser, "id" | "meta"> = {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "dupe@example.com",
        active: true,
      };
      await store.create(a);

      // UNVERIFIED: case-sensitivity is the OIN default; we match exactly at the store level.
      // See okta-dialect.md §2. Case-insensitive overlay happens in a wrapper, not here.
      await expect(store.create({ ...a })).rejects.toThrow(/userName/i);
    });
  });

  describe("get", () => {
    it("returns null for a nonexistent id (caller maps to 404)", async () => {
      const found = await store.get("00u00000000000000999");
      expect(found).toBeNull();
    });

    it("returns the created user when id matches", async () => {
      const created = await store.create({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "findme@example.com",
        active: true,
      });
      const found = await store.get(created.id);
      expect(found).not.toBeNull();
      expect(found?.userName).toBe("findme@example.com");
    });
  });

  describe("list", () => {
    beforeEach(async () => {
      // Seed 5 users for pagination tests.
      for (let i = 1; i <= 5; i++) {
        await store.create({
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: `user-${i.toString().padStart(3, "0")}@example.com`,
          active: i !== 3, // one inactive user in the set
        });
      }
    });

    it("returns all 5 users with correct totalResults when no filter", async () => {
      const result = await store.list({ startIndex: 1, count: 100 });
      expect(result.total).toBe(5);
      expect(result.resources).toHaveLength(5);
    });

    it("honors count + startIndex per RFC 7644 §3.4.2.4 (1-based)", async () => {
      const page1 = await store.list({ startIndex: 1, count: 2 });
      const page2 = await store.list({ startIndex: 3, count: 2 });
      expect(page1.resources).toHaveLength(2);
      expect(page2.resources).toHaveLength(2);
      expect(page1.resources[0]?.id).not.toBe(page2.resources[0]?.id);
      expect(page1.total).toBe(5); // totalResults ALWAYS reflects the unpaginated count
    });

    it('filters by userName eq "..." per okta-dialect.md §2 (Okta canonical dedup query)', async () => {
      const result = await store.list({
        startIndex: 1,
        count: 100,
        filter: 'userName eq "user-003@example.com"',
      });
      expect(result.total).toBe(1);
      expect(result.resources[0]?.userName).toBe("user-003@example.com");
    });

    it('returns empty ListResponse (NOT 404) for a filter that matches nothing', async () => {
      const result = await store.list({
        startIndex: 1,
        count: 100,
        filter: 'userName eq "nobody@example.com"',
      });
      expect(result.total).toBe(0);
      expect(result.resources).toHaveLength(0);
    });

    it("is case-sensitive on userName filter by default (OIN test suite step 16)", async () => {
      const result = await store.list({
        startIndex: 1,
        count: 100,
        filter: 'userName eq "USER-003@EXAMPLE.COM"',
      });
      expect(result.total).toBe(0); // case-sensitive match — no hit
    });
  });

  describe("patch", () => {
    it("applies a single replace op and updates meta.lastModified", async () => {
      const u = await store.create({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "p@example.com",
        active: true,
      });
      // Artificial delay so meta.lastModified can change on our second-resolution timestamps.
      await new Promise((r) => setTimeout(r, 1100));

      const updated = await store.patch(u.id, [
        { op: "replace", value: { active: false } },
      ]);

      expect(updated).not.toBeNull();
      if (updated === null) throw new Error("unreachable — expect above guards");
      expect(updated.active).toBe(false);
      expect(updated.userName).toBe("p@example.com"); // untouched fields preserved
      expect(updated.meta.lastModified).not.toBe(u.meta.lastModified);
    });

    it("returns null when patching a nonexistent id (caller maps to 404)", async () => {
      const result = await store.patch("00u00000000000000999", [
        { op: "replace", value: { active: false } },
      ]);
      expect(result).toBeNull();
    });

    it("applies multi-op PATCH atomically per RFC 7644 §3.5.2 + okta-dialect.md §1", async () => {
      const u = await store.create({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "m@example.com",
        active: true,
        name: { givenName: "Old", familyName: "Name" },
      });

      const updated = await store.patch(u.id, [
        { op: "replace", value: { active: false } },
        { op: "replace", path: "name.givenName", value: "New" },
      ]);

      expect(updated).not.toBeNull();
      if (updated === null) throw new Error("unreachable — expect above guards");
      expect(updated.active).toBe(false);
      expect(updated.name?.givenName).toBe("New");
      expect(updated.name?.familyName).toBe("Name");
    });

    it("rejects PATCH that would violate userName uniqueness (caller maps to 409 uniqueness)", async () => {
      await store.create({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "a@example.com",
        active: true,
      });
      const b = await store.create({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "b@example.com",
        active: true,
      });

      await expect(
        store.patch(b.id, [{ op: "replace", path: "userName", value: "a@example.com" }]),
      ).rejects.toThrow(/userName/i);
    });
  });
});
