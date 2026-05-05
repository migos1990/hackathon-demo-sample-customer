import { describe, it, expect } from "vitest";
import { signManifest, verifyManifest, MIN_KEY_LENGTH } from "./sign.js";
import type { PromotionManifest, SigningKey } from "./types.js";

const MANIFEST: PromotionManifest = {
  manifest_version: 1,
  customer_slug: "acme-hr",
  ticket_id: "LIN-1234",
  git_commit: "b7c15c9abcdef0123456789abcdef0123456789a",
  git_tag: "v1.0.0-acme-hr",
  preprod_tenant: "demo-customer-a-staging.oktapreview.com",
  prod_tenant: "demo-customer-a-prod.okta.com",
  terraform_module_version: "0.3.1",
  fixtures_hash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  preprod_verify: {
    ran_at: "2026-05-05T14:00:00Z",
    tsc_clean: true,
    vitest_passed: "143/143",
    oin_spec_tests_passed: "12/12",
    tf_plan_empty: true,
    smoke_test_passed: true,
    log_errors_count: 0,
  },
  approver_github_username: "lmigault",
  approved_at: "2026-05-05T14:05:00Z",
};

const CURRENT_KEY: SigningKey = {
  id: "current",
  secret: "a".repeat(64), // 64 chars = 512-bit — matches HMAC-SHA256 block size
};
const PREVIOUS_KEY: SigningKey = {
  id: "previous",
  secret: "b".repeat(64),
};
const WRONG_KEY: SigningKey = {
  id: "adversary",
  secret: "c".repeat(64),
};

describe("signManifest", () => {
  it("produces a signed envelope with the manifest, signature, key_id, and signed_at", () => {
    const signed = signManifest(MANIFEST, CURRENT_KEY);
    expect(signed.manifest).toEqual(MANIFEST);
    expect(signed.key_id).toBe("current");
    expect(signed.signature).toMatch(/^[a-f0-9]{64}$/); // 32 bytes HMAC-SHA256 hex
    expect(signed.signed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("is deterministic for the same manifest + key (same canonicalization → same HMAC)", () => {
    // signed_at differs between calls; compare signatures only.
    const a = signManifest(MANIFEST, CURRENT_KEY);
    const b = signManifest(MANIFEST, CURRENT_KEY);
    expect(a.signature).toBe(b.signature);
  });

  it("produces a different signature when ANY manifest field changes", () => {
    const a = signManifest(MANIFEST, CURRENT_KEY);
    const b = signManifest({ ...MANIFEST, customer_slug: "different" }, CURRENT_KEY);
    expect(a.signature).not.toBe(b.signature);
  });

  it("produces a different signature when a nested preprod_verify field changes", () => {
    const a = signManifest(MANIFEST, CURRENT_KEY);
    const b = signManifest(
      { ...MANIFEST, preprod_verify: { ...MANIFEST.preprod_verify, log_errors_count: 1 } },
      CURRENT_KEY,
    );
    expect(a.signature).not.toBe(b.signature);
  });

  it("produces a different signature when the key changes", () => {
    const a = signManifest(MANIFEST, CURRENT_KEY);
    const b = signManifest(MANIFEST, PREVIOUS_KEY);
    expect(a.signature).not.toBe(b.signature);
  });

  it("is invariant to JSON key ordering in the input manifest (RFC 8785 canonicalization)", () => {
    // Build the same logical manifest with keys in a different order.
    const reordered = {
      approved_at: MANIFEST.approved_at,
      approver_github_username: MANIFEST.approver_github_username,
      preprod_verify: MANIFEST.preprod_verify,
      fixtures_hash: MANIFEST.fixtures_hash,
      terraform_module_version: MANIFEST.terraform_module_version,
      prod_tenant: MANIFEST.prod_tenant,
      preprod_tenant: MANIFEST.preprod_tenant,
      git_tag: MANIFEST.git_tag,
      git_commit: MANIFEST.git_commit,
      ticket_id: MANIFEST.ticket_id,
      customer_slug: MANIFEST.customer_slug,
      manifest_version: MANIFEST.manifest_version,
    } as PromotionManifest;
    expect(signManifest(reordered, CURRENT_KEY).signature).toBe(
      signManifest(MANIFEST, CURRENT_KEY).signature,
    );
  });

  it("rejects a signing key shorter than MIN_KEY_LENGTH", () => {
    const short: SigningKey = { id: "weak", secret: "short" };
    expect(() => signManifest(MANIFEST, short)).toThrow(/key.*length|length.*key/i);
    expect(MIN_KEY_LENGTH).toBeGreaterThanOrEqual(32);
  });
});

describe("verifyManifest", () => {
  it("returns true when the signature matches the current key", () => {
    const signed = signManifest(MANIFEST, CURRENT_KEY);
    expect(verifyManifest(signed, { current: CURRENT_KEY })).toEqual({ valid: true, key_id: "current" });
  });

  it("returns false when the signature is tampered (single hex char flipped)", () => {
    const signed = signManifest(MANIFEST, CURRENT_KEY);
    const flipped = signed.signature[0] === "a" ? "b" : "a";
    const tampered = { ...signed, signature: flipped + signed.signature.slice(1) };
    const result = verifyManifest(tampered, { current: CURRENT_KEY });
    expect(result.valid).toBe(false);
  });

  it("returns false when ANY manifest field is tampered after signing", () => {
    const signed = signManifest(MANIFEST, CURRENT_KEY);
    const tampered = {
      ...signed,
      manifest: { ...signed.manifest, customer_slug: "attacker-controlled" },
    };
    expect(verifyManifest(tampered, { current: CURRENT_KEY }).valid).toBe(false);
  });

  it("accepts signatures from the PREVIOUS key during the rotation window", () => {
    const signedWithPrev = signManifest(MANIFEST, PREVIOUS_KEY);
    expect(
      verifyManifest(signedWithPrev, { current: CURRENT_KEY, previous: PREVIOUS_KEY }),
    ).toEqual({ valid: true, key_id: "previous" });
  });

  it("rejects previous-key signatures once previous is rotated out of the window", () => {
    const signedWithPrev = signManifest(MANIFEST, PREVIOUS_KEY);
    // After a second rotation, previous is gone — only current accepts.
    expect(verifyManifest(signedWithPrev, { current: CURRENT_KEY }).valid).toBe(false);
  });

  it("rejects a signature from an unknown key id even if it happens to hash-match (theoretical, defense in depth)", () => {
    // The envelope declares key_id; verifier checks against its configured keys.
    // An adversary forging a valid signature with a different key_id would
    // still fail HMAC comparison against current/previous keys.
    const forged = {
      ...signManifest(MANIFEST, WRONG_KEY),
      key_id: "current", // lie about which key signed
    };
    expect(verifyManifest(forged, { current: CURRENT_KEY }).valid).toBe(false);
  });
});
