/**
 * Acme HR System SCIM Connector — composes skeleton.createApp with a
 * UserStore backed by HttpAcmeHrSystemClient.
 *
 * Pattern mirrors connectors/acme-hr/server.ts. The connector is the
 * composition point:
 *
 *   skeleton (SCIM-facing routes + middleware)
 *     + AcmeHrSystemUserStore (UserStore impl over native API)
 *     + attribute mapping (scim ↔ LDAP-shaped native)
 *     = a SCIM 2.0 server Okta can point at.
 *
 * Auth:
 *   - SCIM-facing (what Okta presents): `SCIM_AUTH_TOKEN` env var.
 *     docs/okta-dialect.md §9 — bearer token, reject unauthenticated with 401.
 *   - Target-facing (what we present to Acme HR System): `ACME_HR_API_TOKEN`
 *     env var per OKT-10 auth_credential_env_var. Connector Law 4 SECRETS-OUT.
 *
 * The DELETE handler is wired via the connector-specific users router
 * (connectors/acme-hr-system/routes/users.ts) which mounts the skeleton
 * router + adds DELETE → soft-delete. We cannot use createApp's default
 * usersRouter because it lacks DELETE. Instead we mount the skeleton base
 * app and add the connector router on top, de-duplicating middleware.
 *
 * Factory-per-app: no module-level state. Tests spin up isolated instances.
 */
import express, {
  type Application,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { metaRouter } from "../../skeleton/routes/meta.js";
import { healthzRouter } from "../../skeleton/routes/healthz.js";
import { bearerAuth } from "../../skeleton/middleware/auth.js";
import { requestId } from "../../skeleton/middleware/request-id.js";
import { HttpAcmeHrSystemClient } from "./client.js";
import { AcmeHrSystemUserStore } from "./store.js";
import { acmeHrSystemUsersRouter } from "./routes/users.js";

export interface CreateAcmeHrSystemConnectorOptions {
  /**
   * Base URL of the Acme HR System native API.
   * Per OKT-10 environments:
   *   dev     → https://dev.acme-hr.example.com
   *   staging → https://staging.acme-hr.example.com
   *   prod    → https://api.acme-hr.example.com
   * Injected from ACME_HR_BASE_URL env var by start.ts.
   */
  targetBaseUrl: string;
  /**
   * Bearer token this connector presents to Acme HR System.
   * Sourced from ACME_HR_API_TOKEN per OKT-10 auth_credential_env_var.
   * Connector Law 4 SECRETS-OUT: NEVER hard-code.
   */
  targetApiToken?: string;
  /**
   * Bearer token Okta must present to this connector.
   * Sourced from SCIM_AUTH_TOKEN env var. Omit for dev-mode (no auth).
   * Production deployments MUST set this — see RUNBOOK.md §1.
   */
  scimAuthToken?: string;
}

export function createAcmeHrSystemConnector(
  options: CreateAcmeHrSystemConnectorOptions,
): Application {
  const app = express();

  const client = new HttpAcmeHrSystemClient({
    baseUrl: options.targetBaseUrl,
    ...(options.targetApiToken !== undefined && {
      apiToken: options.targetApiToken,
    }),
  });
  const store = new AcmeHrSystemUserStore(client);

  // --- Middleware stack (mirrors skeleton/server.ts order) ---

  // Request-ID: every log line + response header correlates by request_id.
  // Connector Law 8 OBSERVABLE.
  app.use(requestId());

  // Body parsing — accept both application/json and application/scim+json per
  // docs/okta-dialect.md §10 "Content-Type nuance": Okta's POST bodies use
  // application/json even though responses expect application/scim+json.
  app.use(
    express.json({
      type: ["application/json", "application/scim+json"],
      limit: "1mb",
    }),
  );

  // /healthz is AUTH-EXEMPT: liveness probes + load balancers need it without
  // credentials. Mount BEFORE bearerAuth. docs/okta-dialect.md §9.
  app.use("/scim/v2", healthzRouter(store));

  // Force SCIM content-type on all SCIM responses per RFC 7644 §3.1.
  // Applied after /healthz so health responses stay application/json.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Content-Type", "application/scim+json; charset=utf-8");
    next();
  });

  // Bearer auth — protects all /scim/v2 routes including metadata.
  // Rejects unauthenticated with 401 per docs/okta-dialect.md §9 and
  // OIN test suite step 20. Connector Law 4 SECRETS-OUT.
  app.use(
    "/scim/v2",
    bearerAuth({
      ...(options.scimAuthToken !== undefined && {
        token: options.scimAuthToken,
      }),
    }),
  );

  // --- Route mounting ---

  // Metadata: /ServiceProviderConfig, /Schemas, /ResourceTypes.
  // docs/okta-dialect.md §10 — Okta reads these on initial app connection.
  app.use("/scim/v2", metaRouter);

  // Users: skeleton routes (GET list, POST create, GET :id, PATCH :id) +
  // connector-specific DELETE :id (soft-delete per OKT-10 lifecycle_policy).
  app.use("/scim/v2/Users", acmeHrSystemUsersRouter(store));

  return app;
}