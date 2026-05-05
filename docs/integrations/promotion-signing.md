# Integration: Promotion Manifest Signing

**Law:** PROD-READINESS (14). Every external integration ships with a dedicated integration doc listing env vars, secrets, rotation mechanics, and a post-deploy verification checklist.

**Scope:** the HMAC-SHA256 + RFC 8785 signing layer for Promotion Manifests at `scripts/promotion-manifest/`. This integration is INTERNAL (signer and verifier are both inside the promotion pipeline trust boundary), but the env-var + key-rotation discipline is production-critical.

**Related docs:**
- `docs/promotion-flow.md` — the flow itself (§4 is the manifest schema, §6 is the rotation-window commitment)
- `scripts/promotion-manifest/sign.ts` — the crypto primitives with inline rationale

---

## Env vars

| Var | Required? | Purpose | Format |
|---|---|---|---|
| `PROMOTION_SIGNING_KEY_CURRENT` | Yes (sign + verify) | The currently-active signing secret | ≥32 chars (`MIN_KEY_LENGTH`), recommended 64 hex chars |
| `PROMOTION_SIGNING_KEY_CURRENT_ID` | No (defaults to `"current"`) | Stable short label for this key; surfaces in signed envelope `key_id` field | Short string, e.g. `"2026q2"` |
| `PROMOTION_SIGNING_KEY_PREVIOUS` | Optional — required during rotation windows (verify only) | Previously-active signing secret; lets in-flight manifests still verify | Same format as CURRENT |
| `PROMOTION_SIGNING_KEY_PREVIOUS_ID` | No (defaults to `"previous"`) | Stable short label for the previous key | Short string |

**Signers only need `CURRENT` (+ `CURRENT_ID`).** Verifiers typically hold BOTH during rotation.

## Generating a key

```bash
openssl rand -hex 32      # 64 chars, 256 bits, HMAC-SHA256-optimal
```

Don't use `head -c 32 /dev/urandom | base64` — the result has base64 padding/chars that encode unevenly and can produce keys shorter than the entropy implies.

**Demo/dev keys:** an ephemeral `openssl rand -hex 32` at session start is fine — they don't need to survive the demo shoot. Never commit a demo key to the repo; the pre-commit secret-scan gate will catch hex strings, but don't rely on it.

**Prod keys:** issued by whatever secret manager owns the promotion pipeline (Vault / AWS Secrets Manager / GCP Secret Manager / 1Password Connect, etc.). Neither the repo nor CI logs should ever see the raw material.

## Rotation procedure

Rotation is a three-step window, typically 24-48h:

```
T+0h   Mint new key → set as PROMOTION_SIGNING_KEY_CURRENT (with new ID)
       Move the old current → PROMOTION_SIGNING_KEY_PREVIOUS (keep old ID)
       Verifiers now accept signatures from EITHER key.
       Signers produce signatures with NEW key only.

T+24h  Audit: any in-flight manifests still signed with previous?
       If yes → wait or re-sign. If no → proceed.

T+48h  Remove PROMOTION_SIGNING_KEY_PREVIOUS entirely.
       Only the new key verifies. Older manifests must be re-signed or
       allowed to expire (they cannot be promoted).
```

**Critical:** don't skip the previous-key stage. A hard cutover breaks any signed manifest that hasn't yet been consumed — the promotion pipeline will refuse apparently-valid manifests because the verifier has lost the key they were signed with.

## Verification (what the prod apply step does)

```bash
cat signed-manifest.json | \
  PROMOTION_SIGNING_KEY_CURRENT="$CURRENT_KEY" \
  PROMOTION_SIGNING_KEY_CURRENT_ID="$CURRENT_ID" \
  PROMOTION_SIGNING_KEY_PREVIOUS="$PREV_KEY" \
  PROMOTION_SIGNING_KEY_PREVIOUS_ID="$PREV_ID" \
  npx tsx scripts/promotion-manifest/cli.ts verify
echo $?   # 0 = valid, non-zero = reject
```

Exit-code dispatch:
- `0` — signature valid against current or previous. Promotion is permitted. The valid key_id is printed on stderr for audit logs.
- `1` — signature does NOT verify. Promotion MUST refuse. Treat as a tampering event if the manifest came from an expected source.
- `2` — malformed JSON on stdin. Input problem, not a signature verdict. Fail-closed.
- `4` — missing env var. Configuration problem. Fail-closed.
- `5` — stdin read failure. I/O problem. Fail-closed.

## Incident response: suspected compromised key

If any of the signing keys may have been exposed (leaked log, committed by accident, ex-employee retained access):

1. **Immediately rotate** — mint a new CURRENT, move the suspected one to PREVIOUS temporarily so verifies don't reject in-flight legit manifests signed before the rotation.
2. **Cap the rotation window short** — 4-6h instead of 24-48h. The shorter the window, the narrower the attack surface.
3. **Audit signed manifests** since the suspected compromise — any manifest signed with the compromised key is untrusted.
4. **Re-sign legitimate manifests** still pending promotion with the new key.
5. **Post-rotation**, remove PREVIOUS. The compromised key is dead.

**Do NOT** attempt to blacklist specific compromised signatures — HMAC is keyed, rotating the key invalidates ALL signatures produced with it. That's the correct revocation mechanism.

## Post-deploy verification checklist

Run all of these once, the first time the signing layer is deployed in any new environment:

- [ ] `PROMOTION_SIGNING_KEY_CURRENT` is set (≥32 chars); `cli.ts sign` on a test manifest exits 0 and produces 64-hex-char `signature`
- [ ] Signed manifest round-trip: `cli.ts sign | cli.ts verify` exits 0 and prints `valid signature (key_id=...)` to stderr
- [ ] Tampering rejection: `cli.ts sign > signed.json; jq '.manifest.customer_slug = "attacker"' signed.json | cli.ts verify` exits non-zero
- [ ] Wrong-key rejection: `PROMOTION_SIGNING_KEY_CURRENT=$(openssl rand -hex 32) cli.ts verify < signed.json` exits non-zero
- [ ] Rotation-window accept: sign with key A (as `previous`), verify with keys A + B (current=B, previous=A) — exit 0
- [ ] Key-length floor: `PROMOTION_SIGNING_KEY_CURRENT=short cli.ts sign < manifest.json` exits non-zero with a length error message on stderr
- [ ] CI does not log the signing key (grep `$CI_LOG` for any env-var value — should find nothing)

## Known limitations (UNVERIFIED until mitigated)

- **Clock skew on `signed_at`** — the envelope's `signed_at` is stamped by the signer's clock. If signer and verifier clocks diverge significantly, downstream freshness checks could reject valid manifests. We don't currently gate on `signed_at` staleness; promotion freshness is implicitly bounded by the rotation window.
- **No hardware-key support** — the crypto runs in Node process memory. A Node-process-level compromise leaks the key. HSM-backed signing is future work; not needed for the hackathon demo.
- **No replay protection at the verifier** — a signed manifest CAN be re-presented to the verifier multiple times. The promotion pipeline handles this out-of-band (ticket state transitions from `preprod_verified → promoted_to_prod` only once per ticket; see `ticket-templates/schema.json` `promotion_gate` block). If the broader pipeline ever loses that state, replay becomes viable. Mitigation: consumed-on-first-use tracking at the verifier, future work.
- **Single signature per envelope** — the partner-distribution flow in `docs/promotion-flow.md` §7 calls for two-of-two signatures (partner + Okta PS). Current implementation is single-signature; two-of-two is designed but not wired. Adding this is a backward-compatible envelope extension (`signatures: [{signature, key_id, signed_at}, ...]`) for a follow-up commit.

---

## Last updated
2026-05-05 — initial integration doc alongside the commits that landed the signing layer.
