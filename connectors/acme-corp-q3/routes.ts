/**
 * AcmeCorpQ3-specific route extensions.
 *
 * The skeleton's usersRouter (skeleton/routes/users.ts) handles:
 *   GET    /scim/v2/Users
 *   POST   /scim/v2/Users
 *   GET    /scim/v2/Users/:id
 *   PATCH  /scim/v2/Users/:id
 *
 * This module adds:
 *   DELETE /scim/v2/Users/:id — soft-delete (ticket OKT-57 required_ops.users_delete=true)
 *
 * Why a separate module rather than extending the skeleton?
 * The skeleton is intentionally kept minimal and customer-agnostic. Customers
 * with users_delete:true get this extension layered on top. The server.ts
 * factory mounts both routers under /scim/v2/Users.
 *
 * Soft-delete semantics (okta-dialect.md §3):
 *   - Okta's deprovisioning signal is PATCH active:false, NOT DELETE.
 *   - DELETE is implemented for edge-case admin-initiated removal.
 *   - BOTH paths resolve to enabled:false — identical end-state.
 *   - "same customer policy MUST yield identical outcomes regardless of which
 *     endpoint Okta hits" — enforced here by calling store.softDelete().
 *
 * Response: 204 No Content on success (RFC 7644 §3.6 — DELETE returns 204).
 * 404 + SCIM error when user not found.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { scimError } from "../../skeleton/middleware/error-envelope.js";
import type { AcmeCorpQ3UserStore } from "./store.js";

export function acmeCorpQ3ExtensionRouter(store: AcmeCorpQ3UserStore): Router {
  const router = Router();

  /**
   * DELETE /scim/v2/Users/:id
   *
   * Soft-delete implementation. Sets enabled:false on the target, retains
   * the row. Returns 204 on success, 404 if not found.
   *
   * okta-dialect.md §3: Okta itself does NOT send DELETE in the standard
   * lifecycle (it uses PATCH active:false). This endpoint exists for
   * admin-initiated forced removal cases and to satisfy
   * required_ops.users_delete:true in ticket OKT-57.
   */
  router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await store.softDelete(req.params["id"]!);
      if (result === null) {
        return res.status(404).json(
          scimError(404, `User not found: ${req.params["id"]}`, "noTarget"),
        );
      }
      // RFC 7644 §3.6: DELETE returns 204 No Content.
      return res.status(204).send();
    } catch (err) {
      return next(err);
    }
  });

  return router;
}