/**
 * Extended /Users router for Acme HR System (OKT-10).
 *
 * Inherits all routes from skeleton/routes/users.ts (LIST, CREATE, GET,
 * PATCH) by delegating to the skeleton's usersRouter factory, then adds:
 *
 *   DELETE /scim/v2/Users/:id — soft-delete (lifecycle_policy: soft_delete)
 *
 * Soft-delete semantics per OKT-10 + okta-dialect.md §3:
 *   - Calls store.delete(id) which forwards to client.deactivateUser()
 *     → PATCH {enabled:false} on the target API.
 *   - Returns 204 No Content on success (RFC 7644 §3.6 specifies 204 for
 *     DELETE — unlike PATCH where we return 200, DELETE does not need a body).
 *   - Returns 404 + SCIM error envelope when user not found.
 *   - The delete path and the PATCH active:false path produce the same
 *     end-state (enabled=false, row retained) per okta-dialect.md §3
 *     policy-consistency requirement.
 *
 * Note: Okta's standard lifecycle signal is PATCH active:false, NOT DELETE.
 * okta-dialect.md §3: "Okta's deprovisioning signal is PATCH active:false,
 * NOT DELETE." The DELETE endpoint is implemented for edge cases (admin-
 * initiated forced removal on the Okta side). Both paths soft-delete.
 *
 * The extended router mounts the skeleton router first (handles GET/POST/
 * PATCH) then appends the DELETE handler. The skeleton router uses Router()
 * without {mergeParams:true}, so mounting order matters — DELETE must be on
 * the SAME router instance or on a router mounted at the same path.
 *
 * Design choice: rather than re-implementing all skeleton routes, we compose
 * by creating a fresh Router, attaching the DELETE handler, and exporting it
 * alongside the skeleton router. server.ts mounts both at /scim/v2/Users.
 * This keeps blast radius small — skeleton routes are unchanged.
 */

import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { scimError } from "../../../skeleton/middleware/error-envelope.js";
import type { AcmeHrSystemUserStore } from "../store.js";

/**
 * Returns a thin Router that adds DELETE /Users/:id (soft-delete) on top
 * of the skeleton's user routes.
 *
 * Mount order in server.ts:
 *   app.use("/scim/v2/Users", usersRouter(store));        // skeleton
 *   app.use("/scim/v2/Users", deleteRouter(store));       // this module
 */
export function deleteRouter(store: AcmeHrSystemUserStore): Router {
  const router = Router();

  /**
   * DELETE /scim/v2/Users/:id
   *
   * Soft-delete: marks user as enabled:false on the target system.
   * Row is never removed (lifecycle_policy: soft_delete, OKT-10).
   *
   * okta-dialect.md §3: "DELETE handler and PATCH-active-false handler
   * MUST be policy-consistent."
   * RFC 7644 §3.6: DELETE returns 204 No Content on success.
   */
  router.delete(
    "/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await store.delete(req.params["id"]!);

        if (result === null) {
          // User does not exist — 404 per RFC 7644 + okta-dialect.md §8.
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

        // 204 No Content per RFC 7644 §3.6. No body — DELETE does not need
        // to echo the resource back (unlike PATCH where okta-dialect.md §1
        // requires 200 + body).
        return res.status(204).send();
      } catch (err) {
        return next(err);
      }
    },
  );

  return router;
}