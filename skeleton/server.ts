/**
 * SCIM 2.0 Server Skeleton — Express app factory.
 *
 * Returns an Express `Application` wired with:
 *   - JSON body parsing (accepts both application/json and application/scim+json
 *     per okta-dialect.md §10 — Okta's POST bodies use application/json even
 *     though responses expect application/scim+json).
 *   - Response Content-Type set to application/scim+json on all 2xx.
 *   - Route mounting under /scim/v2.
 *
 * Factory-per-app lets tests spin up fresh instances without module-level
 * state. No singletons.
 */
import express, { type Application, type NextFunction, type Request, type Response } from "express";
import { metaRouter } from "./routes/meta.js";

export function createApp(): Application {
  const app = express();

  // Accept both content types on POST/PATCH bodies per okta-dialect.md §10.
  app.use(
    express.json({
      type: ["application/json", "application/scim+json"],
      limit: "1mb",
    }),
  );

  // Force SCIM content-type on every 2xx response per RFC 7644 §3.1.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Content-Type", "application/scim+json; charset=utf-8");
    next();
  });

  // Routes. More routers added as endpoints graduate from TDD.
  app.use("/scim/v2", metaRouter);

  return app;
}
