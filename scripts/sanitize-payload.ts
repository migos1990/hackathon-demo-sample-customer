#!/usr/bin/env tsx
/**
 * Sanitize raw Okta SCIM captures (request or response bodies) into
 * fixture-safe text that can be committed to fixtures/okta-payloads/.
 *
 * Redactions are deterministic within one sanitize() call: the same
 * input value is always replaced by the same placeholder, so multi-field
 * fixtures stay internally consistent.
 *
 * NOT sanitized by this tool (redact manually before calling):
 *   - Bearer tokens / auth headers (token format is free-form; can't regex-match safely)
 *   - Customer-specific phone numbers (locale variability makes regex fragile)
 *   - Free-text fields like `title`, `department`, `description` — sanitize by hand
 *
 * Usage:
 *   cat raw-capture.http | npx tsx scripts/sanitize-payload.ts
 *   npx tsx scripts/sanitize-payload.ts raw-capture.http
 */

import { readFileSync } from "node:fs";

export interface Substitutions {
  emails: Record<string, string>;
  tenants: Record<string, string>;
  userIds: Record<string, string>;
  groupIds: Record<string, string>;
  uuids: Record<string, string>;
}

export interface SanitizeResult {
  output: string;
  substitutions: Substitutions;
}

/**
 * Spec constants. Exported so tests assert against the SAME values the
 * implementation uses — prevents silent drift between what we test and
 * what we ship (TRUTH LAW).
 */
export const DEMO_TENANT = "https://demo-customer-a.oktapreview.com";
export const DEMO_EMAIL_DOMAIN = "example.com";

/**
 * Okta opaque IDs: `00u` / `00g` / `00s` prefix + opaque alphanumeric body.
 * Real Okta user IDs are 20 chars total (e.g. `00u1lo2ncxWMNLZwHZrg`) —
 * source: https://developer.okta.com/docs/reference/api/users/#user-attributes.
 * We pad the counter to 17 so placeholder length matches real-world length
 * and downstream parsers can't fail on length-mismatch edge cases.
 */
export const OKTA_OPAQUE_ID_PAD_LEN = 17;
export const UUID_PAD_LEN = 12; // fills the last 12-char segment of an RFC 4122 UUID
export const EMAIL_COUNTER_PAD_LEN = 3; // user-001, user-002, ...

const OKTA_TENANT_RE = /https:\/\/[a-zA-Z0-9][a-zA-Z0-9-]*\.(okta|oktapreview)\.com/g;
const OKTA_USER_ID_RE = /\b00u[a-zA-Z0-9]{17,22}\b/g;
const OKTA_GROUP_ID_RE = /\b00g[a-zA-Z0-9]{17,22}\b/g;
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
// Emails: conservative — require a dot in the domain. Skip anything already at
// example.com (already-redacted input is idempotent).
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

function padId(counter: number, totalLen: number): string {
  return counter.toString().padStart(totalLen, "0");
}

/** Build the deterministic user-ID placeholder for counter n. */
export function oktaUserIdPlaceholder(n: number): string {
  return "00u" + padId(n, OKTA_OPAQUE_ID_PAD_LEN);
}

/** Build the deterministic group-ID placeholder for counter n. */
export function oktaGroupIdPlaceholder(n: number): string {
  return "00g" + padId(n, OKTA_OPAQUE_ID_PAD_LEN);
}

/** Build the deterministic UUID placeholder for counter n. */
export function uuidPlaceholder(n: number): string {
  return `00000000-0000-0000-0000-${padId(n, UUID_PAD_LEN)}`;
}

/** Build the deterministic email placeholder for counter n. */
export function emailPlaceholder(n: number): string {
  return `user-${padId(n, EMAIL_COUNTER_PAD_LEN)}@${DEMO_EMAIL_DOMAIN}`;
}

/**
 * Deterministic sanitizer. Same input → same output across calls.
 * Caller is responsible for redacting any content NOT matched by the
 * patterns documented in the module header.
 */
export function sanitize(input: string): SanitizeResult {
  const substitutions: Substitutions = {
    emails: {},
    tenants: {},
    userIds: {},
    groupIds: {},
    uuids: {},
  };

  let emailCounter = 0;
  let userIdCounter = 0;
  let groupIdCounter = 0;
  let uuidCounter = 0;

  // Tenant URL first — it may contain patterns that would otherwise match
  // user/group IDs if we ran those passes first on a URL fragment.
  let out = input.replace(OKTA_TENANT_RE, (match) => {
    if (match === DEMO_TENANT) {
      return match;
    }
    substitutions.tenants[match] = DEMO_TENANT;
    return DEMO_TENANT;
  });

  // User IDs (00u prefix, 20-25 chars total)
  out = out.replace(OKTA_USER_ID_RE, (match) => {
    if (substitutions.userIds[match]) {
      return substitutions.userIds[match];
    }
    userIdCounter += 1;
    // Keep the full opaque-ID length (20 chars) to avoid downstream parsers
    // rejecting on length mismatch.
    const replacement = "00u" + padId(userIdCounter, 17);
    substitutions.userIds[match] = replacement;
    return replacement;
  });

  // Group IDs (00g prefix)
  out = out.replace(OKTA_GROUP_ID_RE, (match) => {
    if (substitutions.groupIds[match]) {
      return substitutions.groupIds[match];
    }
    groupIdCounter += 1;
    const replacement = "00g" + padId(groupIdCounter, 17);
    substitutions.groupIds[match] = replacement;
    return replacement;
  });

  // UUIDs (RFC 4122 format)
  out = out.replace(UUID_RE, (match) => {
    const normalized = match.toLowerCase();
    if (substitutions.uuids[normalized]) {
      return substitutions.uuids[normalized];
    }
    uuidCounter += 1;
    const n = padId(uuidCounter, 12);
    const replacement = `00000000-0000-0000-0000-${n}`;
    substitutions.uuids[normalized] = replacement;
    return replacement;
  });

  // Emails last — do NOT re-replace example.com addresses (idempotency).
  out = out.replace(EMAIL_RE, (match) => {
    const afterAt = match.split("@")[1];
    if (afterAt === DEMO_EMAIL_DOMAIN) {
      return match;
    }
    if (substitutions.emails[match]) {
      return substitutions.emails[match];
    }
    emailCounter += 1;
    const replacement = `user-${padId(emailCounter, 3)}@${DEMO_EMAIL_DOMAIN}`;
    substitutions.emails[match] = replacement;
    return replacement;
  });

  return { output: out, substitutions };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const inputPath = process.argv[2];
  const raw = inputPath === undefined ? readFileSync(0, "utf8") : readFileSync(inputPath, "utf8");
  const result = sanitize(raw);
  process.stdout.write(result.output);
  if (!result.output.endsWith("\n")) process.stdout.write("\n");
  // Print substitution map to stderr so stdout stays clean for piping.
  process.stderr.write("\n// Substitutions:\n");
  process.stderr.write(JSON.stringify(result.substitutions, null, 2) + "\n");
}
