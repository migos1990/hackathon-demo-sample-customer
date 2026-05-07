/**
 * Acme HR System SCIM Connector — app factory (OKT-10).
 *
 * Composes the skeleton's createApp() with an AcmeHrSystemUserStore backed
 * by an HttpAcmeHrSystemClient. This produces a fully-wired Express
 * Application that:
 *   - Presents a SCIM 2.0 interface to Okta (via the skeleton)
 *   - Translates SCIM operations to Acme HR System's native API (via store
 *     + mapping + client)
 *   - Enforces bearer-token auth (okta-dialect.md §9, OIN step 20)
 *   - Exposes /scim/v2/healthz for liveness probes (Connector Law 8)
 *
 * The DELETE /Users/:id route is wired here with soft-delete semantics
 * (lifecycle_policy=soft_delete per OKT-10). It calls store.softDelete()
 * which sets enabled:false on the target — NEVER removes the row
 * (okta-dialect.md §3).
 *
 * Factory-per-app (no module-level singletons) so tests can spin up
 * isolated instances.
 */
import express, { type Application, type Request, type Response, type NextFunction } from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpAcmeHrSystemClient } from "./client.js";
import { AcmeHrSystemUserStore } from "./store.js";
import { scimError } from "../../skeleton/middleware/error-envelope.js";

export interface CreateAcmeHrSystemConnectorOptions {
  /**
   * Base URL of the Acme HR System API.
   * Defaults to https://api.acme-hr.example.com (prod).
   * Override via ACME_HR_BASE_URL env var in start.ts.
   */
  targetBaseUrl?: string;
  /**
   * Bearer token this connector presents to the Acme HR System API.
   * Sourced from ACME_HR_API_TOKEN env var in production (never hardcode).
   */
  targetApiToken?: string;
  /**
   * Bearer token Okta must present to this connector.
   * Sourced from SCIM_AUTH_TOKEN env var in production.
   * Omit only for dev-mode — the skeleton passes all requests through
   * when auth token is not set.
   */
  scimAuthToken?: string;
  /**
   * Override fetch for testing (MSW, undici, etc.).
   */
  fetchImpl?: typeof fetch;
}

export function createAcmeHrSystemConnector(
  options: CreateAcmeHrSystemConnectorOptions = {},
): Application {
  const targetBaseUrl =
    options.targetBaseUrl ?? "https://api.acme-hr.example.com";

  const client = new HttpAcmeHrSystemClient({
    baseUrl: targetBaseUrl,
    ...(options.targetApiToken !== undefined && {
      apiToken: options.targetApiToken,
    }),
    ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
  });

  const userStore = new AcmeHrSystemUserStore(client);

  // Build the base SCIM app from the skeleton.
  const app = createApp({
    userStore,
    ...(options.scimAuthToken !== undefined && {
      authToken: options.scimAuthToken,
    }),
  });

  // Wire the DELETE /Users/:id route with soft-delete semantics.
  //
  // The skeleton's usersRouter does not include DELETE (it's optional per
  // the skeleton's TDD progression). We add it here as a connector-level
  // concern because the lifecycle policy (soft_delete) is customer-specific.
  //
  // Per okta-dialect.md §3: Okta's own deprovisioning flow uses
  // `PATCH active:false`, NOT DELETE. This DELETE endpoint satisfies RFC
  // 7644 §3.6 and any admin-initiated forced-removal flow on the Okta side.
  // Both paths MUST yield the same end-state under soft_delete policy.
  app.delete(
    "/scim/v2/Users/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await userStore.softDelete(req.params["id"]!);
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
        // RFC 7644 §3.6: DELETE responds with 204 No Content on success.
        // okta-dialect.md §3: the user row is retained (soft-delete policy).
        return res.status(204).send();
      } catch (err) {
        return next(err);
      }
    },
  );

  return app;
}