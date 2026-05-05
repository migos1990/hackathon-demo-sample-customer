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
import { usersRouter } from "./routes/users.js";
import { healthzRouter } from "./routes/healthz.js";
import { InMemoryUserStore, type UserStore } from "./store/user-store.js";
import { bearerAuth } from "./middleware/auth.js";
import { requestId } from "./middleware/request-id.js";

export interface CreateAppOptions {
  /**
   * Injected UserStore. Defaults to a fresh InMemoryUserStore per call so
   * tests can spin up isolated instances. Production uses this hook to
   * inject a customer-specific backing store (Postgres / LDAP proxy / etc).
   */
  userStore?: UserStore;
  /**
   * Bearer token for authentication. When omitted, auth is DISABLED
   * (dev-mode convenience). Production deployments MUST set this — the
   * generated server's runbook + env template surface this requirement.
   */
  authToken?: string;
  /**
   * Require bearer auth on /ServiceProviderConfig, /Schemas, /ResourceTypes.
   * Default: false (metadata is public per SCIM convention).
   */
  requireAuthOnMetadata?: boolean;
}

export function createApp(options: CreateAppOptions = {}): Application {
  const app = express();
  const userStore = options.userStore ?? new InMemoryUserStore();

  // Request-ID first — every downstream log line and response header
  // can correlate by res.locals.request_id (Connector Law 8 OBSERVABLE).
  app.use(requestId());

  // Accept both content types on POST/PATCH bodies per okta-dialect.md §10.
  app.use(
    express.json({
      type: ["application/json", "application/scim+json"],
      limit: "1mb",
    }),
  );

  // /healthz is AUTH-EXEMPT so liveness probes + load balancers can reach
  // it without credentials. Must be mounted BEFORE the bearerAuth middleware.
  // Returns 200 when the optional store.ping() succeeds (or is absent);
  // 503 when ping rejects (target unreachable). Content-Type is JSON, NOT
  // scim+json — this is a connector-level health surface, not a SCIM resource.
  app.use("/scim/v2", healthzRouter(userStore));

  // Force SCIM content-type on every SCIM response per RFC 7644 §3.1.
  // Applies AFTER /healthz mount so health responses keep application/json.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Content-Type", "application/scim+json; charset=utf-8");
    next();
  });

  // Bearer auth — mounted at /scim/v2 so it protects ALL downstream routes
  // (including metadata, unless exempted inside the middleware per
  // okta-dialect.md §9 guidance).
  app.use(
    "/scim/v2",
    bearerAuth({
      ...(options.authToken !== undefined && { token: options.authToken }),
      ...(options.requireAuthOnMetadata !== undefined && {
        requireAuthOnMetadata: options.requireAuthOnMetadata,
      }),
    }),
  );

  // Routes. More routers added as endpoints graduate from TDD.
  app.use("/scim/v2", metaRouter);
  app.use("/scim/v2/Users", usersRouter(userStore));

  return app;
}
