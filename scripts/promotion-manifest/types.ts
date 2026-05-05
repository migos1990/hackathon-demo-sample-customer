/**
 * Promotion Manifest — schema matches docs/promotion-flow.md §4.
 *
 * A Promotion Manifest pins the exact commit + fixtures + verify results
 * that passed pre-prod, so the prod apply can cryptographically assert:
 * "this is the same thing we tested." HMAC-SHA256 over RFC 8785 canonical
 * JSON is the signing primitive.
 *
 * Signed envelope format (SignedPromotionManifest) wraps the manifest with
 * signature metadata so the verifier can identify which key signed it.
 */

export interface PromotionManifest {
  manifest_version: 1;
  customer_slug: string;
  ticket_id: string;
  git_commit: string;
  git_tag: string;
  preprod_tenant: string;
  prod_tenant: string;
  terraform_module_version: string;
  /** SHA-256 of the fixtures tree, hex-encoded. Pinning input payloads prevents drift between tested and shipped behavior. */
  fixtures_hash: string;
  preprod_verify: PreprodVerify;
  approver_github_username: string;
  /** ISO-8601 timestamp the approver clicked promote. */
  approved_at: string;
}

export interface PreprodVerify {
  /** ISO-8601 timestamp the verify gate ran. */
  ran_at: string;
  tsc_clean: boolean;
  /** e.g. "143/143" — string to preserve human readability in the rendered JSON. */
  vitest_passed: string;
  /** e.g. "12/12" — the OIN SPEC Test count that passed. */
  oin_spec_tests_passed: string;
  tf_plan_empty: boolean;
  smoke_test_passed: boolean;
  log_errors_count: number;
}

/**
 * Signed envelope. The `manifest` is the exact object that was canonicalized
 * and signed. Verifiers re-canonicalize `manifest` to reproduce the signing
 * input. `signature` is hex-encoded HMAC-SHA256 bytes.
 *
 * `key_id` identifies WHICH signing key produced the signature so the
 * verifier can select from its rotation window. We use short stable ids
 * ("current", "previous") rather than the key material itself.
 */
export interface SignedPromotionManifest {
  manifest: PromotionManifest;
  signature: string;
  key_id: string;
  /** ISO-8601 timestamp the signature was produced. Separate from approved_at for forensic clarity. */
  signed_at: string;
}

export interface SigningKey {
  /** Stable short identifier surfaced in the signed envelope. */
  id: string;
  /** Raw secret material. Min length enforced in sign.ts. */
  secret: string;
}
