/**
 * /Users router for the Acme HR System connector. Extends the skeleton's
 * users router with a DELETE handler wired to the soft-delete policy.
 *
 * Why a separate router instead of reusing skeleton/routes/users.ts?
 * The skeleton router does not include DELETE (it is not required by the
 * skeleton's base OIN surface). OKT-10 sets `users_delete: true`, so we
 * need it. Rather than patching the skeleton (BLAST-RADIUS LAW), we compose:
 * this router mounts the skeleton router and adds DELETE on top.
 *
 * Soft-delete contract per docs/okta-dialect.md §3:
 *   "DELETE handler and PATCH-active-false handler MUST be policy-consistent."
 *   Both paths call client.deactivateUser → { enabled: false } on the target.
 *   The row is never physically removed.
 *
 * Response codes:
 *   DELETE success → 204 No Content (RFC 7644 §3.6, Okta accepts this on DELETE)
 *   DELETE not found → 404 + SCIM Error envelope (docs/okta-dialect.md §8)
 *
 * Note: Okta drives deactivation via PATCH active:false in its normal lifecycle
 * (docs/okta-dialect.md §3). The DELETE endpoint exists for explicit admin-
 * initiated removal flows. Both arrive at the same end-state on the native API.
 */
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { usersRouter as skeletonUsersRouter } from "../../../skeleton/routes/users.js";
import { scimError } from "../../../skeleton/middleware/error-envelope.js";
import type { AcmeHrSystemUserStoreInterface } from "../store.js";

export function acmeHrSystemUsersRouter(
  store: AcmeHrSystemUserStoreInterface,
): Router {
  const router = Router();

  // Mount the skeleton's users router first. It handles:
  //   GET  /          (list)
  //   POST /          (create)
  //   GET  /:id       (read)
  //   PATCH /:id      (update + active:false deactivation)
  // The skeleton router is already wired to call store.create/get/list/patch,
  // which delegate to the soft-delete-aware store implementation above.
  router.use("/", skeletonUsersRouter(store));

  // DELETE /:id — soft-delete only (OKT-10 lifecycle_policy: soft_delete).
  // docs/okta-dialect.md §3: "Okta's deprovisioning signal is PATCH active:false,
  // NOT DELETE." DELETE is still implemented to satisfy OKT-10 users_delete:true
  // but maps to the same { enabled:false } outcome on the native API.
  router.delete(
    "/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params["id"];
        if (!id) {
          return res
            .status(400)
            .json(scimError(400, "Missing user id in path", "invalidValue"));
        }

        const found = await store.delete(id);
        if (!found) {
          // docs/okta-dialect.md §8: 404 + scimType:noTarget per RFC 7644 §3.12.
          return res
            .status(404)
            .json(scimError(404, `User not found: ${id}`, "noTarget"));
        }

        // RFC 7644 §3.6: "The server responds with a 204 (No Content) response code."
        // Okta accepts 204 on DELETE (unlike PATCH where it expects 200 + body
        // per docs/okta-dialect.md §1). No body on 204.
        return res.status(204).send();
      } catch (err) {
        return next(err);
      }
    },
  );

  return router;
}