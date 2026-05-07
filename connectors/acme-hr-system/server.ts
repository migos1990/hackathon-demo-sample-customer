/**
 * Acme HR System SCIM Connector — Express app factory.
 *
 * Composes:
 *   - skeleton/server.ts (createApp) — SCIM routes + middleware
 *   - AcmeHrSystemUserStore — UserStore backed by HttpAcmeHrSystemClient
 *   - DELETE /Users/:id route — soft-delete extension beyond skeleton's
 *     base UserStore interface (OKT-10 required_ops.users_delete=true)
 *
 * The skeleton's createApp handles:
 *   - Bearer auth (okta-dialect.md §9)
 *   - Content-Type: application/scim+json (okta-dialect.md §10)
 *   - GET/POST /Users, GET/PATCH /Users/:id, metadata endpoints
 *   - /healthz (Connector Law 8 OBSERVABLE)
 *
 * This factory adds DELETE /Users/:id on top, mounting it AFTER createApp
 * wires the existing routes.
 *
 * Factory-per-app — no module-level state. Tests spin up isolated instances.
 *
 * Ticket: OKT-10
 */

import express, { type Application, type NextFunction, type Request, type Response } from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpAcmeHrSystemClient } from "./client.js";
import { AcmeHrSystemUserStore } from "./store.js";
import { scimError } from "../../skeleton/middleware/error-envelope.js";
import { bearerAuth } from "../../skeleton/middleware/auth.js";

export interface CreateAcmeHrSystemConnectorOptions {
  /**
   * Base URL of the Acme HR System target API.
   * From OKT-10 ticket environments map or ACME_HR_SYSTEM_BASE_URL env var.
   * Example: "https://api.acme-hr.example.com"
   */
  targetBaseUrl: string;
  /**
   * Bearer token the connector presents to Acme HR System.
   * From ACME_HR_API_TOKEN env var (OKT-10 auth_credential_env_var).
   * Omit in dev-mode (auth disabled for local iteration).
   */
  targetApiToken?: string;
  /**
   * Bearer token Okta must present to THIS connector.
   * From SCIM_AUTH_TOKEN env var.
   * Omit in dev-mode only.
   */
  scimAuthToken?: string;
  /**
   * Override fetch (e.g. undici mock in tests).
   */
  fetchImpl?: typeof fetch;
}

export function createAcmeHrSystemConnector(
  options: CreateAcmeHrSystemConnectorOptions,
): Application {
  const client = new HttpAcmeHrSystemClient({
    baseUrl: options.targetBaseUrl,
    ...(options.targetApiToken !== undefined && {
      apiToken: options.targetApiToken,
    }),
    ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
  });

  const userStore = new AcmeHrSystemUserStore(client);

  // Build the base SCIM app from the skeleton (GET/POST /Users,
  // GET/PATCH /Users/:id, metadata, /healthz, auth middleware).
  const app = createApp({
    userStore,
    ...(options.scimAuthToken !== undefined && {
      authToken: options.scimAuthToken,
    }),
  });

  // ---------------------------------------------------------------------------
  // DELETE /scim/v2/Users/:id — soft-delete extension
  //
  // The skeleton's createApp does not include a DELETE route because RFC 7644
  // makes it optional and Okta's primary lifecycle path is PATCH active:false
  // (okta-dialect.md §3). OKT-10 sets required_ops.users_delete=true, so we
  // add it here.
  //
  // Auth note: the skeleton already wired bearerAuth on /scim/v2/* inside
  // createApp. We re-apply it here because this route is mounted separately
  // on the app instance — without it, DELETE would be auth-exempt.
  // okta-dialect.md §9: "Enforce auth on EVERY /Users/* route."
  // ---------------------------------------------------------------------------
  app.delete(
    "/scim/v2/Users/:id",
    bearerAuth(
      options.scimAuthToken !== undefined
        ? { token: options.scimAuthToken }
        : {},
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const found = await userStore.delete(req.params["id"]!);
        if (!found) {
          // OIN test suite step 22: non-existent ID → 404.
          // okta-dialect.md §8 error envelope.
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
        // okta-dialect.md §1 "Status 204 on PATCH" only applies to PATCH;
        // DELETE correctly returns 204 with no body.
        return res.status(204).send();
      } catch (err) {
        return next(err);
      }
    },
  );

  // Generic error handler — catches anything next(err) propagates.
  // Returns SCIM Error envelope (NOT HTML) per okta-dialect.md §8.
  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      console.error("[acme-hr-system] unhandled error:", err);
      res.status(500).json(
        scimError(
          500,
          "Internal server error — check connector logs for details",
        ),
      );
    },
  );

  return app;
}