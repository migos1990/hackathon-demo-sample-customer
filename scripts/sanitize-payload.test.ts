import { describe, it, expect } from "vitest";
import {
  sanitize,
  DEMO_TENANT,
  oktaUserIdPlaceholder,
  oktaGroupIdPlaceholder,
  uuidPlaceholder,
  emailPlaceholder,
} from "./sanitize-payload.js";

describe("sanitize", () => {
  it("replaces a single email with the first email placeholder", () => {
    const result = sanitize("mail: jdoe@acme-hr.real-customer.com");
    expect(result.output).toBe(`mail: ${emailPlaceholder(1)}`);
  });

  it("keeps the same email mapped consistently within one payload", () => {
    const input = "a=jdoe@real.com\nb=jdoe@real.com\nc=other@real.com";
    const result = sanitize(input);
    expect(result.output).toBe(
      `a=${emailPlaceholder(1)}\nb=${emailPlaceholder(1)}\nc=${emailPlaceholder(2)}`
    );
  });

  it("replaces an Okta tenant URL with the demo placeholder", () => {
    const result = sanitize("POST https://realcustomer.okta.com/scim/v2/Users");
    expect(result.output).toBe(`POST ${DEMO_TENANT}/scim/v2/Users`);
  });

  it("normalizes both .okta.com and .oktapreview.com to the demo placeholder", () => {
    const input = "A=https://a.okta.com\nB=https://b.oktapreview.com";
    const result = sanitize(input);
    expect(result.output).toBe(`A=${DEMO_TENANT}\nB=${DEMO_TENANT}`);
  });

  it("replaces Okta user IDs (00u-prefixed opaque strings) with predictable placeholders", () => {
    const input = 'id: "00u1a2b3c4d5e6f7g8h9i"';
    const result = sanitize(input);
    expect(result.output).toBe(`id: "${oktaUserIdPlaceholder(1)}"`);
  });

  it("replaces Okta group IDs (00g-prefixed) with predictable placeholders", () => {
    const input = 'groupId: "00g7x8y9z0a1b2c3d4e5"';
    const result = sanitize(input);
    expect(result.output).toBe(`groupId: "${oktaGroupIdPlaceholder(1)}"`);
  });

  it("replaces UUIDs with predictable placeholder UUIDs", () => {
    const input = "externalId=a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const result = sanitize(input);
    expect(result.output).toBe(`externalId=${uuidPlaceholder(1)}`);
  });

  it("maps the same UUID consistently if it appears twice", () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const input = `a=${uuid},b=${uuid}`;
    const result = sanitize(input);
    expect(result.output).toBe(`a=${uuidPlaceholder(1)},b=${uuidPlaceholder(1)}`);
  });

  it("handles a mixed payload with all pattern types", () => {
    const input = [
      "POST https://realcustomer.okta.com/scim/v2/Users",
      "Authorization: Bearer real-token-12345",
      "",
      '{"id": "00u1234567890abcdefgh",',
      ' "userName": "jdoe@real-customer.com",',
      ' "externalId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"}',
    ].join("\n");
    const result = sanitize(input);
    expect(result.output).toContain(DEMO_TENANT);
    expect(result.output).toContain(`"id": "${oktaUserIdPlaceholder(1)}"`);
    expect(result.output).toContain(`"userName": "${emailPlaceholder(1)}"`);
    expect(result.output).toContain(`"externalId": "${uuidPlaceholder(1)}"`);
    expect(result.output).not.toContain("realcustomer");
    expect(result.output).not.toContain("a1b2c3d4-e5f6-7890");
    expect(result.output).not.toContain("real-customer.com");
    // Note: bearer tokens aren't pattern-matched (token format is free-form);
    // redact those manually before running sanitize.
  });

  it("returns the substitution map so human reviewers can audit replacements", () => {
    const input = "u=jdoe@real.com t=https://real.okta.com";
    const result = sanitize(input);
    expect(result.substitutions.emails).toEqual({
      "jdoe@real.com": emailPlaceholder(1),
    });
    expect(result.substitutions.tenants).toEqual({
      "https://real.okta.com": DEMO_TENANT,
    });
  });

  it("never changes content that has no PII patterns", () => {
    const input = '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"active":true}';
    const result = sanitize(input);
    expect(result.output).toBe(input);
  });

  it("leaves example.com addresses alone (already redacted)", () => {
    const input = "user@example.com";
    const result = sanitize(input);
    expect(result.output).toBe(input);
  });

  it("leaves the demo tenant URL alone (already redacted)", () => {
    const input = `${DEMO_TENANT}/scim/v2/Users`;
    const result = sanitize(input);
    expect(result.output).toBe(input);
  });
});
