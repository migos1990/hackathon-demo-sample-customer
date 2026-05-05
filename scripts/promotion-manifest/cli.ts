#!/usr/bin/env node
/**
 * Promotion Manifest CLI.
 *
 * Usage:
 *   tsx scripts/promotion-manifest/cli.ts sign   < manifest.json > signed.json
 *   tsx scripts/promotion-manifest/cli.ts verify < signed.json
 *
 * sign:
 *   Reads a PromotionManifest from stdin. Signs with the env-configured
 *   current key. Writes a SignedPromotionManifest (pretty-printed JSON) to
 *   stdout. Exit 0 on success.
 *
 * verify:
 *   Reads a SignedPromotionManifest from stdin. Verifies against current
 *   (and optional previous) env-configured keys. Exit 0 on valid, non-zero
 *   on invalid. Verdict goes to stderr so stdout stays clean for piping.
 *
 * Env vars:
 *   PROMOTION_SIGNING_KEY_CURRENT        (required, ≥32 chars)
 *   PROMOTION_SIGNING_KEY_CURRENT_ID     (default: "current")
 *   PROMOTION_SIGNING_KEY_PREVIOUS       (optional; enables rotation window on verify)
 *   PROMOTION_SIGNING_KEY_PREVIOUS_ID    (default: "previous")
 */
import { readFileSync } from "node:fs";
import { signManifest, verifyManifest, type VerifyKeys } from "./sign.js";
import type { PromotionManifest, SignedPromotionManifest, SigningKey } from "./types.js";

function main(): void {
  const subcommand = process.argv[2];

  switch (subcommand) {
    case "sign":
      return runSign();
    case "verify":
      return runVerify();
    default:
      printUsage();
      process.exit(1);
  }
}

function runSign(): void {
  const key = readCurrentKeyOrExit();
  const input = readStdinOrExit();
  let manifest: PromotionManifest;
  try {
    manifest = JSON.parse(input) as PromotionManifest;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`sign: failed to parse JSON manifest: ${msg}\n`);
    process.exit(2);
  }

  try {
    const signed = signManifest(manifest!, key);
    process.stdout.write(JSON.stringify(signed, null, 2) + "\n");
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`sign: ${msg}\n`);
    process.exit(3);
  }
}

function runVerify(): void {
  const keys = readVerifyKeysOrExit();
  const input = readStdinOrExit();
  let signed: SignedPromotionManifest;
  try {
    signed = JSON.parse(input) as SignedPromotionManifest;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`verify: failed to parse JSON signed manifest: ${msg}\n`);
    process.exit(2);
  }

  const result = verifyManifest(signed!, keys);
  if (result.valid) {
    process.stderr.write(`verify: valid signature (key_id=${result.key_id})\n`);
    process.exit(0);
  }
  process.stderr.write(`verify: INVALID signature — refusing to promote\n`);
  process.exit(1);
}

function readCurrentKeyOrExit(): SigningKey {
  const secret = process.env.PROMOTION_SIGNING_KEY_CURRENT;
  if (!secret) {
    process.stderr.write("sign: PROMOTION_SIGNING_KEY_CURRENT is required (≥32 chars)\n");
    process.exit(4);
  }
  const id = process.env.PROMOTION_SIGNING_KEY_CURRENT_ID ?? "current";
  return { id, secret };
}

function readVerifyKeysOrExit(): VerifyKeys {
  const curSecret = process.env.PROMOTION_SIGNING_KEY_CURRENT;
  if (!curSecret) {
    process.stderr.write("verify: PROMOTION_SIGNING_KEY_CURRENT is required\n");
    process.exit(4);
  }
  const keys: VerifyKeys = {
    current: {
      id: process.env.PROMOTION_SIGNING_KEY_CURRENT_ID ?? "current",
      secret: curSecret,
    },
  };
  const prevSecret = process.env.PROMOTION_SIGNING_KEY_PREVIOUS;
  if (prevSecret) {
    keys.previous = {
      id: process.env.PROMOTION_SIGNING_KEY_PREVIOUS_ID ?? "previous",
      secret: prevSecret,
    };
  }
  return keys;
}

function readStdinOrExit(): string {
  try {
    return readFileSync(0, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cli: failed to read stdin: ${msg}\n`);
    process.exit(5);
  }
}

function printUsage(): void {
  process.stderr.write(
    [
      "Unknown subcommand. Usage:",
      "  promotion-manifest sign   < manifest.json > signed.json",
      "  promotion-manifest verify < signed.json",
      "",
      "Env:",
      "  PROMOTION_SIGNING_KEY_CURRENT        (required, ≥32 chars)",
      "  PROMOTION_SIGNING_KEY_CURRENT_ID     (default: current)",
      "  PROMOTION_SIGNING_KEY_PREVIOUS       (optional; enables rotation window on verify)",
      "  PROMOTION_SIGNING_KEY_PREVIOUS_ID    (default: previous)",
      "",
    ].join("\n"),
  );
}

main();
