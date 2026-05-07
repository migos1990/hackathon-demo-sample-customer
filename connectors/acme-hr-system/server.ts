/**
 * Acme HR System SCIM Connector — Express app factory.
 *
 * Composes skeleton's createApp() with a UserStore backed by
 * HttpAcmeHrSystemClient. This is the complete SCIM server Okta points at.
 *
 * Architecture (mirrors connectors/acme-hr/server.ts):
 *
 *   createApp (skeleton) ← injects AcmeHrSystemUserStore
 *     AcmeHrSystemUserStore ← calls AcmeHrClient + mapping.ts
 *       HttpAcmeHrSystemClient ← hits https://api.acme-hr.example.com
 *
 * Soft-delete extension:
 *   The skeleton's usersRouter handles GET, POST, PATCH. DELETE is wired
 *   here via an additional route layer that calls store.softDelete().
 *   okta-dialect.md §3: Okta does NOT use DELETE in the standard lifecycle
 *   (it uses PATCH active: false), but we implement it for edge cases per
 *   ticket OKT-10 required_ops.users_delete: true.
 *
 * Auth:
 *   SCIM_AUTH_TOKEN — bearer token Okta presents to THIS connector.
 *   Passed through createApp({ authToken }) which wires skeleton/middleware/auth.ts.
 *   okta-dialect.md §9: reject unauthenticated requests with 401.
 */
import express, { type Application, type Request, type Response, type NextFunction } from "express";
import { createApp } from "../../skeleton/server.js";
import { scimError } from "../../skeleton/middleware/error-envelope.js";
import { HttpAcmeHrSystemClient } from "./client.js";
import { AcmeHrSystemUserStore } from "./store.js";

export interface CreateAcmeHrSystemConnectorOptions {
  /** Base URL of the native Acme HR System API. */
  targetBaseUrl: string;
  /**
   * Bearer token the connector presents to the native API.
   * Maps to ACME_HR_API_TOKEN env var (ticket OKT-10
   * auth_credential_env_var: ACME_HR_API_TOKEN).
   * Omit only in dev/test mode.
   */
  targetApiToken?: string;
  /**
   * Bearer token Okta must present to this SCIM connector.
   * Maps to SCIM_AUTH_TOKEN env var.
   * Omit only in dev/test mode — production MUST set this.
   */
  scimAuthToken?: string;
}

export function createAcmeHrSystemConnector(
  options: CreateAcmeHrSystemConnectorOptions,
): Application {
  const client = new HttpAcmeHrSystemClient({
    baseUrl: options.targetBaseUrl,
    ...(options.targetApiToken !== undefined && {
      apiToken: options.targetApiToken,
    }),
  });
  const store = new AcmeHrSystemUserStore(client);

  // Compose skeleton app — handles /scim/v2/Users (GET, POST, GET/:id, PATCH/:id),
  // /scim/v2/ServiceProviderConfig, /scim/v2/Schemas, /scim/v2/ResourceTypes,
  // /scim/v2/healthz, and bearer auth middleware.
  const app = createApp({
    userStore: store,
    ...(options.scimAuthToken !== undefined && {
      authToken: options.scimAuthToken,
    }),
  });

  // ─── Soft-delete: DELETE /scim/v2/Users/:id ────────────────────────────────
  //
  // Ticket OKT-10 required_ops.users_delete: true + lifecycle_policy: soft_delete.
  //
  // okta-dialect.md §3: "The DELETE endpoint may be implemented for edge cases
  // (admin-initiated forced removal on the customer app side) but Okta itself
  // drives lifecycle through the `active` flag."
  //
  // This route is mounted AFTER skeleton's router so it supplements, not
  // replaces, the existing GET/POST/PATCH routes. Express matches by
  // declaration order; DELETE on /:id is distinct from PATCH on /:id and
  // won't collide.
  app.delete(
    "/scim/v2/Users/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await store.softDelete(req.params["id"]!);
        if (result === null) {
          // User not found — 404 per RFC 7644 §3.6 and OIN test suite step 22.
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
        // RFC 7644 §3.6: successful DELETE returns 204 No Content.
        // Soft-delete means the row is retained (enabled: false) — we
        // return 204 because the SCIM resource is logically removed from
        // Okta's perspective even though the native row is preserved.
        return res.status(204).send();
      } catch (err) {
        return next(err);
      }
    },
  );

  return app;
}