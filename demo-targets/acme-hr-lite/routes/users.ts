/**
 * /users routes for AcmeHR-lite.
 *
 * LDAP-shaped JSON API (NOT SCIM). The generated SCIM connector translates
 * between SCIM (Okta) and these endpoints — the attribute-mapping work is
 * the visible agent output in the demo.
 */
import { Router, type Request, type Response } from "express";
import type { InMemoryAcmeHrStore } from "../store.js";
import type { AcmeHrUserCreate, AcmeHrUserPatch } from "../types.js";

export function usersRouter(store: InMemoryAcmeHrStore): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    res.json(store.list());
  });

  router.get("/:uid", (req: Request, res: Response) => {
    const user = store.get(req.params.uid!);
    if (!user) return res.status(404).json({ error: "not_found" });
    return res.json(user);
  });

  router.post("/", (req: Request, res: Response) => {
    const input = req.body as AcmeHrUserCreate;
    try {
      const created = store.create(input);
      return res.status(201).json(created);
    } catch (err) {
      const message = err instanceof Error ? err.message : "create_failed";
      if (/uid already exists/i.test(message)) {
        return res.status(409).json({ error: "uid_conflict", detail: message });
      }
      return res.status(400).json({ error: "invalid_input", detail: message });
    }
  });

  router.patch("/:uid", (req: Request, res: Response) => {
    const patch = req.body as AcmeHrUserPatch;
    const updated = store.patch(req.params.uid!, patch);
    if (!updated) return res.status(404).json({ error: "not_found" });
    return res.json(updated);
  });

  return router;
}
