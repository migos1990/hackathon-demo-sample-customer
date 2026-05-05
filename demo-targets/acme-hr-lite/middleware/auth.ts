/**
 * Bearer-token auth for AcmeHR-lite.
 *
 * Follows the same pattern as `skeleton/middleware/auth.ts` but trimmed:
 * - no metadata-path exemption (AcmeHR-lite has no `/Schemas`-equivalent)
 * - dev-mode pass-through when apiToken is undefined/empty (mirrors skeleton
 *   behavior documented in docs/integrations/express.md)
 *
 * Constant-time comparison to avoid timing oracles. UNVERIFIED at scale —
 * short-token benefit is marginal; included as minor hardening, not a
 * load-bearing claim. Tests assert accept/reject behavior only, not timing.
 */
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export interface AcmeHrAuthOptions {
  /** Bearer token to require. Omit or empty for dev-mode (no auth). */
  apiToken?: string;
}

export function acmeHrAuth(options: AcmeHrAuthOptions): RequestHandler {
  const { apiToken } = options;

  return (req, res, next) => {
    if (apiToken === undefined || apiToken === "") return next();

    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "missing_or_invalid_authorization_header" });
    }

    const presented = header.slice("Bearer ".length);
    if (!constantTimeEqual(presented, apiToken)) {
      return res.status(401).json({ error: "invalid_token" });
    }

    return next();
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
