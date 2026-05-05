import { describe, it, expect } from "vitest";
import { scimToAcmeHrCreate, acmeHrToScim, scimPatchToAcmeHrPatch } from "./mapping.js";
import type { ScimUser, StoredUser } from "../../skeleton/types.js";
import type { AcmeHrUser } from "../../demo-targets/acme-hr-lite/types.js";

const SCIM_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const ENT_SCHEMA = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

describe("mapping: SCIM → AcmeHR (create)", () => {
  it("maps userName → uid and flattens primary email → mail", () => {
    const scim: Omit<ScimUser, "id" | "meta"> = {
      schemas: [SCIM_SCHEMA],
      userName: "jdoe",
      name: { givenName: "Jane", familyName: "Doe", formatted: "Jane Doe" },
      emails: [{ value: "jdoe@acme-hr.example.com", primary: true, type: "work" }],
      active: true,
    };
    const acme = scimToAcmeHrCreate(scim);
    expect(acme.uid).toBe("jdoe");
    expect(acme.mail).toBe("jdoe@acme-hr.example.com");
    expect(acme.givenName).toBe("Jane");
    expect(acme.sn).toBe("Doe");
    expect(acme.cn).toBe("Jane Doe");
    expect(acme.enabled).toBe(true);
  });

  it("falls back to first email when no email is marked primary", () => {
    const scim: Omit<ScimUser, "id" | "meta"> = {
      schemas: [SCIM_SCHEMA],
      userName: "jdoe",
      emails: [
        { value: "home@example.com", type: "home" },
        { value: "work@example.com", type: "work" },
      ],
      active: true,
    };
    expect(scimToAcmeHrCreate(scim).mail).toBe("home@example.com");
  });

  it("composes cn from given + family when name.formatted is absent", () => {
    const scim: Omit<ScimUser, "id" | "meta"> = {
      schemas: [SCIM_SCHEMA],
      userName: "jdoe",
      name: { givenName: "Jane", familyName: "Doe" },
      emails: [{ value: "j@example.com", primary: true }],
      active: true,
    };
    expect(scimToAcmeHrCreate(scim).cn).toBe("Jane Doe");
  });

  it("handles single-token names (sn:null) — Madonna case from ticket template", () => {
    const scim: Omit<ScimUser, "id" | "meta"> = {
      schemas: [SCIM_SCHEMA],
      userName: "madonna",
      name: { givenName: "Madonna" },
      emails: [{ value: "m@example.com", primary: true }],
      active: true,
    };
    const acme = scimToAcmeHrCreate(scim);
    expect(acme.givenName).toBe("Madonna");
    expect(acme.sn).toBeNull();
    expect(acme.cn).toBe("Madonna");
  });

  it("defaults active to true when absent (RFC 7643 §4.1.1 — active is optional, assumed true)", () => {
    const scim: Omit<ScimUser, "id" | "meta"> = {
      schemas: [SCIM_SCHEMA],
      userName: "jdoe",
      emails: [{ value: "j@example.com", primary: true }],
    };
    expect(scimToAcmeHrCreate(scim).enabled).toBe(true);
  });

  it("respects active:false (deactivation on create — rare but spec-legal)", () => {
    const scim: Omit<ScimUser, "id" | "meta"> = {
      schemas: [SCIM_SCHEMA],
      userName: "jdoe",
      emails: [{ value: "j@example.com", primary: true }],
      active: false,
    };
    expect(scimToAcmeHrCreate(scim).enabled).toBe(false);
  });

  it("maps enterprise extension fields (employeeNumber, department, title) when present", () => {
    const scim: Omit<ScimUser, "id" | "meta"> = {
      schemas: [SCIM_SCHEMA, ENT_SCHEMA],
      userName: "jdoe",
      emails: [{ value: "j@example.com", primary: true }],
      active: true,
      extensions: {
        [ENT_SCHEMA]: {
          employeeNumber: "E-1234",
          department: "R&D",
        },
      },
    };
    const acme = scimToAcmeHrCreate(scim);
    expect(acme.employeeNumber).toBe("E-1234");
    expect(acme.department).toBe("R&D");
  });

  it("leaves enterprise fields null when the extension is absent", () => {
    const scim: Omit<ScimUser, "id" | "meta"> = {
      schemas: [SCIM_SCHEMA],
      userName: "jdoe",
      emails: [{ value: "j@example.com", primary: true }],
      active: true,
    };
    const acme = scimToAcmeHrCreate(scim);
    expect(acme.employeeNumber).toBeNull();
    expect(acme.department).toBeNull();
    expect(acme.title).toBeNull();
  });

  it("throws when userName is absent — AcmeHR requires uid", () => {
    const scim: Omit<ScimUser, "id" | "meta"> = {
      schemas: [SCIM_SCHEMA],
      emails: [{ value: "j@example.com", primary: true }],
      active: true,
    };
    expect(() => scimToAcmeHrCreate(scim)).toThrow(/userName/i);
  });

  it("throws when no email is present — AcmeHR requires mail", () => {
    const scim: Omit<ScimUser, "id" | "meta"> = {
      schemas: [SCIM_SCHEMA],
      userName: "jdoe",
      active: true,
    };
    expect(() => scimToAcmeHrCreate(scim)).toThrow(/email|mail/i);
  });
});

describe("mapping: AcmeHR → SCIM (read)", () => {
  const baseAcme: AcmeHrUser = {
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
    lastModified: "2026-05-05T14:22:00.000Z",
  };

  it("uses uid as both SCIM id AND userName (LDAP-backed SCIM convention)", () => {
    const scim: StoredUser = acmeHrToScim(baseAcme);
    expect(scim.id).toBe("jdoe");
    expect(scim.userName).toBe("jdoe");
  });

  it("produces a minimal-valid SCIM schemas array", () => {
    const scim = acmeHrToScim(baseAcme);
    expect(scim.schemas).toContain(SCIM_SCHEMA);
  });

  it("maps name fields back with formatted composed from cn", () => {
    const scim = acmeHrToScim(baseAcme);
    expect(scim.name?.givenName).toBe("Jane");
    expect(scim.name?.familyName).toBe("Doe");
    expect(scim.name?.formatted).toBe("Jane Doe");
  });

  it("omits familyName when sn is null (Madonna case round-trips)", () => {
    const madonna: AcmeHrUser = { ...baseAcme, uid: "madonna", sn: null, cn: "Madonna", givenName: "Madonna" };
    const scim = acmeHrToScim(madonna);
    expect(scim.name?.givenName).toBe("Madonna");
    expect(scim.name?.familyName).toBeUndefined();
  });

  it("renders mail as a primary work email", () => {
    const scim = acmeHrToScim(baseAcme);
    expect(scim.emails).toHaveLength(1);
    expect(scim.emails?.[0]?.value).toBe("jdoe@acme-hr.example.com");
    expect(scim.emails?.[0]?.primary).toBe(true);
    expect(scim.emails?.[0]?.type).toBe("work");
  });

  it("maps enabled → active and lastModified → meta.lastModified", () => {
    const scim = acmeHrToScim(baseAcme);
    expect(scim.active).toBe(true);
    expect(scim.meta.resourceType).toBe("User");
    expect(scim.meta.lastModified).toBe("2026-05-05T14:22:00.000Z");
  });

  it("surfaces enterprise extension fields when present", () => {
    const scim = acmeHrToScim(baseAcme);
    const ent = scim.extensions?.[ENT_SCHEMA] as Record<string, unknown> | undefined;
    expect(ent?.employeeNumber).toBe("E-1234");
    expect(ent?.department).toBe("R&D");
  });

  it("skips the enterprise extension when all its fields are null", () => {
    const sparse: AcmeHrUser = {
      ...baseAcme,
      employeeNumber: null,
      department: null,
      title: null,
    };
    const scim = acmeHrToScim(sparse);
    // Either absent, or present-but-empty is acceptable. Assert absence for cleanliness.
    expect(scim.extensions?.[ENT_SCHEMA]).toBeUndefined();
  });
});

describe("mapping: SCIM PATCH → AcmeHR PATCH", () => {
  it("maps replace-at-root active:false → enabled:false (the OIN deactivation flow)", () => {
    const ops = [{ op: "replace", value: { active: false } } as const];
    const patch = scimPatchToAcmeHrPatch(ops);
    expect(patch.enabled).toBe(false);
  });

  it("maps path-based replace name.givenName → givenName", () => {
    const ops = [{ op: "replace", path: "name.givenName", value: "Janet" } as const];
    const patch = scimPatchToAcmeHrPatch(ops);
    expect(patch.givenName).toBe("Janet");
  });

  it("maps path-based replace active → enabled", () => {
    const ops = [{ op: "replace", path: "active", value: false } as const];
    const patch = scimPatchToAcmeHrPatch(ops);
    expect(patch.enabled).toBe(false);
  });

  it("ignores unsupported op targets (forward-compat, doesn't throw)", () => {
    const ops = [
      { op: "replace", value: { active: false } } as const,
      { op: "replace", path: "nonexistentField", value: "x" } as const,
    ];
    const patch = scimPatchToAcmeHrPatch(ops);
    expect(patch.enabled).toBe(false);
    // Does not pollute patch with unsupported fields.
    expect(Object.keys(patch)).toEqual(["enabled"]);
  });

  it("handles multi-op atomic PATCH per RFC 7644 §3.5.2", () => {
    const ops = [
      { op: "replace", value: { active: false } } as const,
      { op: "replace", path: "name.givenName", value: "Janet" } as const,
    ];
    const patch = scimPatchToAcmeHrPatch(ops);
    expect(patch.enabled).toBe(false);
    expect(patch.givenName).toBe("Janet");
  });
});
