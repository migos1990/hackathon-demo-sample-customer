/**
 * HMAC-SHA256 sign / verify over RFC 8785 canonical JSON for Promotion
 * Manifests.
 *
 * Why HMAC not signatures: HMAC is symmetric. We don't need public
 * verification — the verifier is the same trust boundary as the signer
 * (the promotion pipeline itself). HMAC keeps the implementation small
 * and the ceremony minimal.
 *
 * Why RFC 8785: equal JSON objects (same keys, same values, any key order)
 * MUST produce the same signature. JSON.stringify isn't stable across key
 * orderings; RFC 8785 (JCS) fixes that.
 *
 * Why two-key rotation: during a key rotation, in-flight manifests signed
 * with the previous key need to still verify. The verifier holds BOTH
 * current and previous for a rotation window (documented as 24-48h in
 * docs/promotion-flow.md §6). After the window, previous is dropped;
 * manifests older than that must be re-signed or allowed to expire.
 *
 * Why constant-time comparison: prevent timing oracles on signature values.
 * The threat model here is weak (HMAC-SHA256 is 32 bytes; timing leakage
 * takes billions of attempts to exploit against a short input), but the
 * marginal cost is trivial and the habit is worth keeping.
 */
import canonicalize from "canonicalize";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { PromotionManifest, SignedPromotionManifest, SigningKey } from "./types.js";

/**
 * Minimum signing-key length in bytes. 32 bytes = 256 bits matches
 * HMAC-SHA256's output size; anything shorter provides no additional
 * security. Enforced in signManifest() so weak demo keys can't ship.
 */
export const MIN_KEY_LENGTH = 32;

export interface VerifyKeys {
  current: SigningKey;
  previous?: SigningKey;
}

export interface VerifyResult {
  valid: boolean;
  /** Which key accepted the signature (if valid). Useful for audit logs. */
  key_id?: string;
}

export function signManifest(
  manifest: PromotionManifest,
  key: SigningKey,
): SignedPromotionManifest {
  if (key.secret.length < MIN_KEY_LENGTH) {
    throw new Error(
      `signing key length ${key.secret.length} below minimum ${MIN_KEY_LENGTH}`,
    );
  }

  const canonical = canonicalize(manifest);
  if (canonical === undefined) {
    // canonicalize returns undefined for non-representable inputs (e.g. functions).
    // Our PromotionManifest type precludes this, but guard explicitly.
    throw new Error("manifest is not canonicalizable");
  }

  const signature = hmacHex(key.secret, canonical);

  return {
    manifest,
    signature,
    key_id: key.id,
    signed_at: new Date().toISOString(),
  };
}

export function verifyManifest(
  signed: SignedPromotionManifest,
  keys: VerifyKeys,
): VerifyResult {
  const canonical = canonicalize(signed.manifest);
  if (canonical === undefined) return { valid: false };

  // Verify against current first (hot path); fall back to previous during rotation.
  const candidates: SigningKey[] = [keys.current];
  if (keys.previous) candidates.push(keys.previous);

  for (const key of candidates) {
    if (key.secret.length < MIN_KEY_LENGTH) continue; // skip weak keys defensively
    const expected = hmacHex(key.secret, canonical);
    if (constantTimeHexEqual(signed.signature, expected)) {
      return { valid: true, key_id: key.id };
    }
  }

  return { valid: false };
}

function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function constantTimeHexEqual(a: string, b: string): boolean {
  // Length mismatch short-circuits before the timingSafeEqual call, which
  // throws on mismatched buffer sizes. For same-length hex strings this is
  // still constant-time within the compare.
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}
