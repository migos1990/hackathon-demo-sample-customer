/**
 * DELETE /Users/:id — soft-delete extension route.
 *
 * The skeleton's users.ts router does not include a DELETE handler because
 * the base skeleton is minimal and DELETE semantics are policy-driven.
 * This module exports a router patch function that adds DELETE to the
 * existing Users router.
 *
 * Policy: SOFT DELETE (okta-dialect.md §3, ticket lifecycle_policy).
 * Okta's own deprovisioning uses PATCH active=false, NOT DELETE. When an
 * admin issues a hard-delete in Okta's UI after deactivating a user, Okta
 * does NOT call DELETE on the SCIM server ("user resource inside your SCIM
 * app isn't changed" — okta-dialect.md §3). The DELETE endpoint is
 * implemented because required_ops.users_delete=true but it produces the
 * same outcome as PATCH active=false: enabled=false, row retained.
 *
 * Returns:
 *   204 No Content   on successful soft-delete (RFC 7644 §3.6)
 *   404 + SCIM Error when user not found
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { scimError } from "../../../skeleton/middleware/error-envelope.js";
import type { AcmeHrSystemUserStoreInterface } from "../store.js";

export function usersDeleteRouter(
  store: AcmeHrSystemUserStoreInterface,
): Router {
  const router = Router();

  router.delete(
    "/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await store.delete(req.params["id"]!);
        if (result === null) {
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
        // RFC 7644 §3.6: successful DELETE → 204 No Content.
        // Soft-delete policy: user row persists with enabled=false.
        return res.status(204).send();
      } catch (err) {
        return next(err);
      }
    },
  );

  return router;
}