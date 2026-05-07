/**
 * Extended /Users router for the Acme HR System connector.
 *
 * ticket: OKT-10
 * customer: Acme HR System
 * slug: acme-hr-system
 *
 * Extends the skeleton's usersRouter (skeleton/routes/users.ts) with a
 * DELETE handler that implements the soft_delete lifecycle policy from OKT-10.
 *
 * Why a separate router rather than modifying the skeleton?
 *   - The skeleton's DELETE handler is intentionally absent (soft_delete and
 *     hard_delete have different semantics; the skeleton stays policy-neutral).
 *   - Per BLAST-RADIUS LAW: changes to the skeleton affect ALL connectors;
 *     a per-connector router extension isolates this customer's policy.
 *   - Generated connectors that need DELETE can import and mount this pattern.
 *
 * DELETE semantics per okta-dialect.md §3 (lifecycle_policy: soft_delete):
 *   - Okta normally drives deactivation through PATCH active:false, NOT DELETE.
 *   - DELETE /Users/:id is an edge-case admin flow; we honour it by performing
 *     a soft-delete (enabled:false on the target), never a hard delete.
 *   - Response: 204 No Content on success (standard REST DELETE convention).
 *     Okta accepts 204 for DELETE; it only requires 200+body for PATCH
 *     per okta-dialect.md §1 "Status 204 on PATCH" anti-pattern note.
 *   - 404 when the user does not exist on the target.
 *
 * The router is composed on top of the skeleton's usersRouter in server.ts.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { scimError } from "../../../skeleton/middleware/error-envelope.js";
import type { AcmeHrSystemUserStore } from "../store.js";

/**
 * Returns an Express Router that adds DELETE /Users/:id on top of the
 * skeleton's existing GET, POST, GET/:id, PATCH/:id routes.
 *
 * The store parameter must be an AcmeHrSystemUserStore so the router can
 * access the softDelete() method (which is not part of the base UserStore
 * interface — it is a connector-specific extension).
 */
export function acmeHrSystemUsersDeleteRouter(
  store: AcmeHrSystemUserStore,
): Router {
  const router = Router();

  /**
   * DELETE /scim/v2/Users/:id
   *
   * lifecycle_policy: soft_delete — sets enabled:false on the Acme HR System
   * target. Does NOT remove the row. Per okta-dialect.md §3:
   *   "DELETE cascading to group memberships — it should NOT."
   * Group memberships are NOT touched; the user is simply deactivated.
   *
   * Response:
   *   204 No Content — successful soft-delete.
   *   404 — user not found on the target (never existed or was already gone).
   */
  router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await store.softDelete(req.params["id"]!);
      if (updated === null) {
        // User not found on the target.
        return res
          .status(404)
          .json(
            scimError(
              404,
              `User not found: ${req.params["id"]}`,
              "noTarget",
            ),
          );
      }
      // 204 No Content — soft-delete succeeded. Body intentionally empty.
      return res.status(204).send();
    } catch (err) {
      return next(err);
    }
  });

  return router;
}