/**
 * Bearer-token auth middleware for SCIM routes.
 *
 * Behavior per okta-dialect.md §9:
 *   - Accept `Authorization: Bearer <token>` only; reject Basic / other schemes with 401
 *   - Constant-time comparison (crypto.timingSafeEqual) to avoid timing oracle
 *     (UNVERIFIED at scale — short token length makes this a weak benefit; included
 *     as-a-minor-hardening rather than a load-bearing claim)
 *   - Missing/wrong → 401 + SCIM Error envelope per RFC 7644 §3.12
 *   - Metadata endpoints (/ServiceProviderConfig, /Schemas, /ResourceTypes)
 *     are exempt by default (public metadata is SCIM convention). Flip
 *     via requireAuthOnMetadata: true if a customer needs it.
 *   - When authToken is omitted entirely, middleware is a no-op (dev-mode
 *     convenience; production ALWAYS configures a token — enforced via the
 *     customer-facing runbook on the generated server).
 *
 * OIN step 20 (Required Test: Check status 401) is satisfied by this
 * middleware + the skeleton's Error envelope.
 */
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { scimError } from "./error-envelope.js";

const METADATA_PATHS = new Set([
  "/ServiceProviderConfig",
  "/Schemas",
  "/ResourceTypes",
]);

export interface BearerAuthOptions {
  /** Secret bearer token clients must present. Omit for dev-mode (no auth). */
  token?: string;
  /** Require auth even on metadata endpoints. Default false (public metadata). */
  requireAuthOnMetadata?: boolean;
}

export function bearerAuth(options: BearerAuthOptions): RequestHandler {
  const { token, requireAuthOnMetadata = false } = options;

  return (req, res, next) => {
    // Dev mode: no token configured = pass everything through.
    // Documented in docs/integrations/express.md as DEV-ONLY behavior.
    if (token === undefined || token === "") {
      return next();
    }

    // Exempt metadata endpoints (path relative to the mount point).
    // Express sets req.path to the sub-path; req.baseUrl is "/scim/v2".
    if (!requireAuthOnMetadata && METADATA_PATHS.has(req.path)) {
      return next();
    }

    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      return res
        .status(401)
        .json(scimError(401, "Missing or invalid Authorization header; expected Bearer scheme"));
    }

    const presented = header.slice("Bearer ".length);

    if (!constantTimeEqual(presented, token)) {
      return res.status(401).json(scimError(401, "Invalid bearer token"));
    }

    return next();
  };
}

/**
 * Constant-time string equality. Short-circuits to false on length mismatch
 * before the constant-time compare to avoid hashing each different-length
 * candidate to the same buffer size. UNVERIFIED: at short token lengths
 * (< 32 bytes), the marginal benefit over === is small; this is included
 * as minor hardening, not a load-bearing guarantee. Tests assert correct
 * accept/reject behavior, not timing characteristics.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
