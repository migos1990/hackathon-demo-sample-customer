/**
 * /Users routes per RFC 7644 §3.4 and okta-dialect.md §1-§6.
 *
 * This cycle adds GET /Users/:id. Subsequent TDD cycles add LIST,
 * CREATE, PATCH. Per BLAST-RADIUS LAW the store is injected — no
 * module-level state.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import type { UserStore } from "../store/user-store.js";
import { scimError } from "../middleware/error-envelope.js";

export function usersRouter(store: UserStore): Router {
  const router = Router();

  router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await store.get(req.params["id"]!);
      if (user === null) {
        return res.status(404).json(scimError(404, `User not found: ${req.params["id"]}`, "noTarget"));
      }
      return res.status(200).json(user);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
