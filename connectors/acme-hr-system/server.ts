/**
 * Acme HR System SCIM Connector — app factory.
 *
 * Composes:
 *   skeleton/server.ts (createApp) ← SCIM-facing routes + middleware
 *   + AcmeHrSystemUserStore         ← UserStore backed by the native API
 *   + HttpAcmeHrSystemClient        ← HTTP fan-out to target
 *
 * Also wires the DELETE /Users/:id soft-delete handler on top of the
 * skeleton's router. The skeleton does not include a DELETE route by
 * default (DELETE is optional in OIN); we add it here because
 * `required_ops.users_delete: true` is set in OKT-10 and the policy
 * (soft_delete) is implemented by AcmeHrSystemUserStore.softDelete().
 *
 * Auth tokens:
 *   SCIM_AUTH_TOKEN       — Bearer token Okta presents TO this connector.
 *   ACME_HR_API_TOKEN     — Bearer token this connector presents TO the target.
 * Both injected from environment — never hard-coded (Law 4 SECRETS-OUT).
 */
import express, { type Application, type Request, type Response, type NextFunction } from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpAcmeHrSystemClient } from "./client.js";
import { AcmeHrSystemUserStore } from "./store.js";
import { scimError } from "../../skeleton/middleware/error-envelope.js";

export interface CreateAcmeHrSystemConnectorOptions {
  /** Base URL of the Acme HR System target API. */
  targetBaseUrl: string;
  /** Bearer token for requests to the target API. Omit for dev-mode. */
  targetApiToken?: string;
  /** Bearer token Okta must present to this connector. Omit for dev-mode. */
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
  const userStore = new AcmeHrSystemUserStore(client);

  // Build the base skeleton app — this wires /scim/v2/Users (GET list,
  // POST create, GET :id, PATCH :id), /scim/v2/ServiceProviderConfig,
  // /scim/v2/Schemas, /scim/v2/ResourceTypes, /scim/v2/healthz, and
  // bearer auth middleware.
  const app = createApp({
    userStore,
    ...(options.scimAuthToken !== undefined && {
      authToken: options.scimAuthToken,
    }),
  });

  // ── DELETE /scim/v2/Users/:id ─────────────────────────────────────────
  //
  // Soft-delete handler. Lifecycle policy = soft_delete (OKT-10).
  // okta-dialect.md §3: "Okta does NOT use DELETE /Users/{id} at all in the
  // standard lifecycle" — deprovisioning goes through PATCH active=false.
  // We implement DELETE because required_ops.users_delete=true, but we
  // honour the policy: DELETE resolves to {enabled:false}, NOT a hard delete.
  // "DELETE handler and PATCH-active-false handler MUST be policy-consistent."
  //
  // Returns 204 No Content on success (RFC 7644 §3.6).
  // Returns 404 + SCIM error envelope when user does not exist.
  app.delete(
    "/scim/v2/Users/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const found = await userStore.softDelete(req.params["id"]!);
        if (!found) {
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
        // 204 per RFC 7644 §3.6. No body on delete response.
        return res.status(204).send();
      } catch (err) {
        return next(err);
      }
    },
  );

  return app;
}