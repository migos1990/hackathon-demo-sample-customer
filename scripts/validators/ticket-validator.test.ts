/**
 * Ticket-validator tests — AJV validation of the ticket-templates/schema.json
 * against real and malformed ticket objects.
 *
 * The orchestrator's validate-before-dispatch step depends on this. A
 * malformed ticket must NEVER reach the agent — the agent trusts the
 * ticket YAML as ground truth for customer intent, so schema violations
 * need to bounce at the gate.
 */
import { describe, it, expect } from "vitest";
import { validateTicket } from "./ticket-validator.js";

function validTicket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customer_app_name: "AcmeHR",
    customer_slug: "acme-hr",
    auth_method: "bearer",
    auth_credential_location: "env",
    auth_credential_env_var: "ACME_HR_API_TOKEN",
    base_url: "https://api.acme-hr.example.com",
    environments: {
      dev: "https://api.dev.acme-hr.example.com",
      staging: "https://api.staging.acme-hr.example.com",
      prod: "https://api.acme-hr.example.com",
    },
    user_model_source: "ldap",
    required_ops: {
      users_create: true,
      users_read: true,
      users_update_patch: true,
      users_delete: true,
      users_list: true,
      users_filter: true,
    },
    lifecycle_policy: "soft_delete",
    target_okta_tenant: "demo-customer-a-staging.oktapreview.com",
    terraform_workspace: "staging",
    promotion_gate: {
      preprod_verified_at: null,
      preprod_manifest_sha: null,
      approver_github_username: null,
      promoted_to_prod_at: null,
    },
    ...overrides,
  };
}

describe("validateTicket", () => {
  it("passes a fully-populated valid ticket", () => {
    const result = validateTicket(validTicket());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  describe("required fields", () => {
    it("fails when customer_app_name is missing", () => {
      const t = validTicket();
      delete t.customer_app_name;
      const result = validateTicket(t);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.path.includes("customer_app_name") || e.message.includes("customer_app_name"))).toBe(true);
    });

    it("fails when promotion_gate is missing (schema version >= 2026-05-05)", () => {
      const t = validTicket();
      delete t.promotion_gate;
      const result = validateTicket(t);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.message.includes("promotion_gate") || e.path.includes("promotion_gate"))).toBe(true);
    });

    it("fails when target_okta_tenant is missing", () => {
      const t = validTicket();
      delete t.target_okta_tenant;
      expect(validateTicket(t).ok).toBe(false);
    });
  });

  describe("customer_slug format", () => {
    it("accepts lowercase-hyphenated slugs", () => {
      expect(validateTicket(validTicket({ customer_slug: "bigco-identity" })).ok).toBe(true);
    });

    it("rejects UPPERCASE slugs", () => {
      const r = validateTicket(validTicket({ customer_slug: "AcmeHR" }));
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.path.includes("customer_slug") || e.message.toLowerCase().includes("pattern"))).toBe(true);
    });

    it("rejects slugs with spaces or underscores", () => {
      expect(validateTicket(validTicket({ customer_slug: "acme hr" })).ok).toBe(false);
      expect(validateTicket(validTicket({ customer_slug: "acme_hr" })).ok).toBe(false);
    });
  });

  describe("auth_method enum", () => {
    it("accepts bearer, basic, oauth_cc", () => {
      expect(validateTicket(validTicket({ auth_method: "bearer" })).ok).toBe(true);
      expect(validateTicket(validTicket({ auth_method: "basic" })).ok).toBe(true);
      expect(validateTicket(validTicket({ auth_method: "oauth_cc" })).ok).toBe(true);
    });

    it("rejects unknown auth methods", () => {
      expect(validateTicket(validTicket({ auth_method: "api_key_query_param" })).ok).toBe(false);
    });
  });

  describe("base_url https-only", () => {
    it("accepts https URLs", () => {
      expect(validateTicket(validTicket({ base_url: "https://api.foo.example.com" })).ok).toBe(true);
    });

    it("rejects http URLs (no plaintext)", () => {
      expect(validateTicket(validTicket({ base_url: "http://api.foo.example.com" })).ok).toBe(false);
    });
  });

  describe("required_ops", () => {
    it("requires the six core user ops", () => {
      const t = validTicket();
      delete (t.required_ops as Record<string, unknown>).users_update_patch;
      expect(validateTicket(t).ok).toBe(false);
    });

    it("allows optional groups family to be absent", () => {
      const t = validTicket();
      const ops = t.required_ops as Record<string, unknown>;
      delete ops.groups;
      delete ops.group_push;
      delete ops.group_members_patch;
      expect(validateTicket(t).ok).toBe(true);
    });
  });

  describe("terraform_workspace", () => {
    it("accepts staging and prod", () => {
      expect(validateTicket(validTicket({ terraform_workspace: "staging" })).ok).toBe(true);
      expect(validateTicket(validTicket({ terraform_workspace: "prod" })).ok).toBe(true);
    });

    it("rejects unknown workspaces like dev or qa", () => {
      expect(validateTicket(validTicket({ terraform_workspace: "dev" })).ok).toBe(false);
      expect(validateTicket(validTicket({ terraform_workspace: "qa" })).ok).toBe(false);
    });
  });

  describe("target_okta_tenant format", () => {
    it("accepts oktapreview.com and okta.com tenants", () => {
      expect(validateTicket(validTicket({ target_okta_tenant: "foo.oktapreview.com" })).ok).toBe(true);
      expect(validateTicket(validTicket({ target_okta_tenant: "foo.okta.com" })).ok).toBe(true);
    });

    it("rejects non-Okta domains", () => {
      expect(validateTicket(validTicket({ target_okta_tenant: "foo.example.com" })).ok).toBe(false);
    });
  });

  describe("promotion_gate", () => {
    it("accepts the null-initialized shape on ticket creation", () => {
      const t = validTicket();
      expect(validateTicket(t).ok).toBe(true);
    });

    it("accepts a populated promotion_gate after pipeline writes", () => {
      const t = validTicket({
        promotion_gate: {
          preprod_verified_at: "2026-05-05T14:00:00Z",
          preprod_manifest_sha: "a".repeat(64),
          approver_github_username: "lmigault",
          promoted_to_prod_at: null,
        },
      });
      expect(validateTicket(t).ok).toBe(true);
    });

    it("rejects a malformed preprod_manifest_sha (not 64 hex chars)", () => {
      const t = validTicket({
        promotion_gate: {
          preprod_verified_at: "2026-05-05T14:00:00Z",
          preprod_manifest_sha: "not-a-hash",
          approver_github_username: "lmigault",
          promoted_to_prod_at: null,
        },
      });
      expect(validateTicket(t).ok).toBe(false);
    });

    it("rejects a malformed approver_github_username (invalid GitHub handle)", () => {
      const t = validTicket({
        promotion_gate: {
          preprod_verified_at: "2026-05-05T14:00:00Z",
          preprod_manifest_sha: "a".repeat(64),
          approver_github_username: "-starts-with-hyphen",
          promoted_to_prod_at: null,
        },
      });
      expect(validateTicket(t).ok).toBe(false);
    });

    it("requires all four sub-fields (no partial promotion_gate)", () => {
      const t = validTicket({
        promotion_gate: {
          preprod_verified_at: null,
          preprod_manifest_sha: null,
          // missing approver_github_username + promoted_to_prod_at
        },
      });
      expect(validateTicket(t).ok).toBe(false);
    });
  });

  describe("additionalProperties strictness", () => {
    it("rejects unknown top-level fields (typos should fail loudly)", () => {
      const t = validTicket({ unknown_field: "oops" });
      const r = validateTicket(t);
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.message.toLowerCase().includes("additional"))).toBe(true);
    });
  });

  describe("reports multiple errors at once", () => {
    it("surfaces all defects on one pass (not one-at-a-time)", () => {
      const t = validTicket({
        auth_method: "invalid",
        base_url: "http://no-https",
        terraform_workspace: "dev",
      });
      const r = validateTicket(t);
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("error reporting shape", () => {
    it("each error has a path and a message", () => {
      const r = validateTicket(validTicket({ base_url: "http://bad" }));
      expect(r.ok).toBe(false);
      for (const e of r.errors) {
        expect(typeof e.path).toBe("string");
        expect(typeof e.message).toBe("string");
        expect(e.message.length).toBeGreaterThan(0);
      }
    });
  });
});
