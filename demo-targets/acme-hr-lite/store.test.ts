import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryAcmeHrStore } from "./store.js";

describe("InMemoryAcmeHrStore", () => {
  let store: InMemoryAcmeHrStore;

  beforeEach(() => {
    store = new InMemoryAcmeHrStore();
  });

  describe("create", () => {
    it("stores a user keyed by uid and stamps lastModified", () => {
      const created = store.create({
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
      });

      expect(created.uid).toBe("jdoe");
      expect(created.cn).toBe("Jane Doe");
      expect(created.enabled).toBe(true);
      // lastModified is ISO-8601 with Z (UTC) — consumers may parse, so shape matters.
      expect(created.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    });

    it("rejects duplicate uid — AcmeHR treats uid as primary key", () => {
      const user = {
        uid: "jdoe",
        cn: "Jane Doe",
        givenName: "Jane",
        sn: "Doe",
        mail: "jdoe@acme-hr.example.com",
        employeeNumber: "E-1234",
        title: null,
        department: null,
        enabled: true,
        memberOf: [],
      };
      store.create(user);
      expect(() => store.create(user)).toThrow(/uid/i);
    });

    it("accepts single-token names (sn: null) — handles 'Madonna' case from ticket template §133", () => {
      const created = store.create({
        uid: "madonna",
        cn: "Madonna",
        givenName: "Madonna",
        sn: null, // single-token name — no family name
        mail: "madonna@acme-hr.example.com",
        employeeNumber: null,
        title: null,
        department: null,
        enabled: true,
        memberOf: [],
      });
      expect(created.sn).toBeNull();
    });
  });

  describe("get", () => {
    it("returns the stored user by uid", () => {
      const created = store.create({
        uid: "jdoe",
        cn: "Jane Doe",
        givenName: "Jane",
        sn: "Doe",
        mail: "jdoe@acme-hr.example.com",
        employeeNumber: "E-1234",
        title: null,
        department: null,
        enabled: true,
        memberOf: [],
      });
      const found = store.get("jdoe");
      expect(found).toEqual(created);
    });

    it("returns null for unknown uid (caller maps to 404)", () => {
      expect(store.get("nobody")).toBeNull();
    });
  });

  describe("list", () => {
    it("returns all users in insertion order", () => {
      store.create({
        uid: "a", cn: "A A", givenName: "A", sn: "A",
        mail: "a@example.com", employeeNumber: null, title: null, department: null,
        enabled: true, memberOf: [],
      });
      store.create({
        uid: "b", cn: "B B", givenName: "B", sn: "B",
        mail: "b@example.com", employeeNumber: null, title: null, department: null,
        enabled: true, memberOf: [],
      });
      const all = store.list();
      expect(all.map((u) => u.uid)).toEqual(["a", "b"]);
    });

    it("returns an empty array when the store is empty", () => {
      expect(store.list()).toEqual([]);
    });
  });

  describe("patch", () => {
    it("applies partial updates and bumps lastModified", async () => {
      const created = store.create({
        uid: "jdoe", cn: "Jane Doe", givenName: "Jane", sn: "Doe",
        mail: "jdoe@example.com", employeeNumber: null, title: null, department: null,
        enabled: true, memberOf: [],
      });
      // Wait >1s so lastModified (second-resolution timestamp) changes deterministically.
      await new Promise((r) => setTimeout(r, 1100));

      const updated = store.patch("jdoe", { enabled: false, title: "Principal Engineer" });
      expect(updated).not.toBeNull();
      expect(updated?.enabled).toBe(false);
      expect(updated?.title).toBe("Principal Engineer");
      // Untouched fields preserved.
      expect(updated?.cn).toBe("Jane Doe");
      expect(updated?.mail).toBe("jdoe@example.com");
      // lastModified advanced.
      expect(updated?.lastModified).not.toBe(created.lastModified);
    });

    it("returns null for unknown uid (caller maps to 404)", () => {
      expect(store.patch("nobody", { enabled: false })).toBeNull();
    });

    it("treats enabled:false as deactivation, NOT deletion — user remains in the store", () => {
      store.create({
        uid: "jdoe", cn: "Jane Doe", givenName: "Jane", sn: "Doe",
        mail: "jdoe@example.com", employeeNumber: null, title: null, department: null,
        enabled: true, memberOf: [],
      });
      store.patch("jdoe", { enabled: false });
      const found = store.get("jdoe");
      expect(found).not.toBeNull();
      expect(found?.enabled).toBe(false);
    });
  });
});
