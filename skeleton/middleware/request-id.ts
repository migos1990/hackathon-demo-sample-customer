/**
 * Request-ID middleware for the SCIM skeleton.
 *
 * Closes Connector Law 8 (OBSERVABLE) together with logger.ts + healthz.
 * Every request gets a short opaque id, surfaced via:
 *   - `res.locals.request_id` for downstream handlers
 *   - `X-Request-Id` response header so clients + upstream proxies can
 *     correlate
 *
 * Policy: if the caller provides a safe `X-Request-Id`, preserve it
 * (enables end-to-end correlation through Okta's retry logic). If the
 * header is missing OR looks unsafe (too long, control characters, or
 * newlines — the log-forging attack surface), generate a fresh one.
 */
import { randomBytes } from "node:crypto";
import type { RequestHandler } from "express";

/** Max byte length for an accepted inbound id. 128 is generous. */
const MAX_INBOUND_ID_LEN = 128;

/** Accepts ASCII letters, digits, `-`, `_`, `.`. Rejects anything else. */
const SAFE_INBOUND_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestId(): RequestHandler {
  return (req, res, next) => {
    const inbound = req.headers["x-request-id"];
    const candidate = typeof inbound === "string" ? inbound : undefined;
    const id = candidate && isSafe(candidate) ? candidate : generateId();

    (res.locals as Record<string, unknown>).request_id = id;
    res.setHeader("x-request-id", id);
    next();
  };
}

function isSafe(id: string): boolean {
  if (id.length > MAX_INBOUND_ID_LEN) return false;
  return SAFE_INBOUND_ID.test(id);
}

function generateId(): string {
  // 16 hex chars = 64 bits of entropy. Collision across a single process
  // lifetime is astronomically unlikely; for cross-fleet correlation we'd
  // use ULID or UUIDv7 — not needed at this scale.
  return randomBytes(8).toString("hex");
}
