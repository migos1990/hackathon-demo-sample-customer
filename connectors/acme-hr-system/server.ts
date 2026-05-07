/**
 * Acme HR System SCIM Connector — server factory.
 *
 * Composes the skeleton's createApp with the AcmeHrSystemUserStore backed
 * by HttpAcmeHrSystemClient. The result is a full SCIM 2.0 server Okta can
 * point at for user provisioning.
 *
 * Adds a DELETE /Users/:id route on top of the skeleton's defaults to
 * implement lifecycle_policy=soft_delete (OKT-10). DELETE soft-deletes
 * rather than hard-deletes, consistent with PATCH active:false semantics
 * per okta-dialect.md §3 "Anti-patterns: Inconsistency between DELETE and
 * PATCH paths".
 *
 * Environments (OKT-10 ticket.environments):
 *   dev:     https://dev.acme-hr.example.com     (ACME_HR_SYSTEM_BASE_URL)
 *   staging: https://staging.acme-hr.example.com
 *   prod:    https://api.acme-hr.example.com
 *
 * Authentication:
 *   - Okta → this connector: SCIM_AUTH_TOKEN env var (bearer)
 *   - This connector → Acme HR API: ACME_HR_API_TOKEN env var (bearer)
 *   Per okta-dialect.md §9 and ticket auth_method=bearer.
 *
 * Ticket: OKT-10
 */
import express, { type Application, type Request, type Response, type NextFunction } from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpAcmeHrSystemClient } from "./client.js";
import { AcmeHrSystemUserStore } from "./store.js";
import { scimError } from "../../skeleton/middleware/error-envelope.js";

export interface CreateAcmeHrSystemConnectorOptions {
  /**
   * Base URL of the Acme HR System API.
   * Defaults to ACME_HR_SYSTEM_BASE_URL env var, then prod URL.
   */
  targetBaseUrl?: string;
  /** Bearer token presented to the Acme HR API. Omit in dev-mode. */
  targetApiToken?: string;
  /** Bearer token Okta must present to this SCIM connector. Omit in dev-mode. */
  scimAuthToken?: string;
}

export function createAcmeHrSystemConnector(
  options: CreateAcmeHrSystemConnectorOptions = {},
): Application {
  const baseUrl =
    options.targetBaseUrl ??
    process.env["ACME_HR_SYSTEM_BASE_URL"] ??
    "https://api.acme-hr.example.com";

  const apiToken =
    options.targetApiToken ?? process.env["ACME_HR_API_TOKEN"];

  const scimToken =
    options.scimAuthToken ?? process.env["SCIM_AUTH_TOKEN"];

  const client = new HttpAcmeHrSystemClient({
    baseUrl,
    ...(apiToken !== undefined && { apiToken }),
  });

  const userStore = new AcmeHrSystemUserStore(client);

  // Build the base skeleton app (handles GET /Users, POST /Users,
  // GET /Users/:id, PATCH /Users/:id, metadata, /healthz, auth).
  const app = createApp({
    userStore,
    ...(scimToken !== undefined && { authToken: scimToken }),
  });

  // -------------------------------------------------------------------------
  // DELETE /scim/v2/Users/:id — soft-delete extension
  //
  // The skeleton does not include a DELETE handler by default (Okta primarily
  // deactivates via PATCH active:false). We add it here because the ticket
  // sets required_ops.users_delete=true.
  //
  // Behaviour per lifecycle_policy=soft_delete: set enabled=false on the
  // native user, return 204 No Content on success (RFC 7644 §3.6).
  // Per okta-dialect.md §3 "Soft delete / deactivate (default)".
  // -------------------------------------------------------------------------
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
        // 204 No Content per RFC 7644 §3.6. Okta's DELETE handler does not
        // parse the response body (unlike PATCH — per okta-dialect.md §1).
        return res.status(204).send();
      } catch (err) {
        return next(err);
      }
    },
  );

  return app;
}