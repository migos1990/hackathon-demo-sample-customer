/**
 * Acme HR System SCIM Connector — Express application factory.
 *
 * Composes:
 *   skeleton.createApp (SCIM-facing routes + middleware)
 *     + AcmeHrSystemUserStore (UserStore wired to the native API)
 *     + custom DELETE /Users/:id route (soft-delete policy)
 *
 * Pattern: connectors/acme-hr/server.ts.
 * The factory returns a new Express Application on every call — no
 * module-level singletons, so tests can spin up isolated instances.
 *
 * DELETE route note:
 *   The skeleton's usersRouter does not yet include a DELETE handler.
 *   Because ticket required_ops.users_delete=true AND lifecycle_policy=
 *   soft_delete, we mount an additional DELETE /scim/v2/Users/:id route
 *   here that calls store.softDelete(). This keeps the skeleton unmodified
 *   (BLAST-RADIUS LAW) while satisfying the customer requirement.
 *   okta-dialect.md §3.
 */

import type { Application, Request, Response } from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpAcmeHrSystemClient } from "./client.js";
import { AcmeHrSystemUserStore } from "./store.js";
import { scimError } from "../../skeleton/middleware/error-envelope.js";

export interface CreateAcmeHrSystemConnectorOptions {
  /**
   * Base URL of the Acme HR System API.
   * Defaults to ACME_HR_BASE_URL env var, then the prod URL from the ticket.
   * Ticket environments: dev=https://dev.acme-hr.example.com,
   *   staging=https://staging.acme-hr.example.com,
   *   prod=https://api.acme-hr.example.com.
   */
  targetBaseUrl?: string;
  /**
   * Bearer token for the Acme HR System API.
   * Per ticket: auth_method=bearer, auth_credential_env_var=ACME_HR_API_TOKEN.
   * okta-dialect.md §9.
   */
  targetApiToken?: string;
  /**
   * Bearer token Okta must present to this connector (SCIM_AUTH_TOKEN).
   * Omit ONLY in dev-mode — production MUST configure this.
   * OIN test suite step 20 (401 on missing auth). okta-dialect.md §9.
   */
  scimAuthToken?: string;
}

export function createAcmeHrSystemConnector(
  options: CreateAcmeHrSystemConnectorOptions = {},
): Application {
  // Resolve config from options → env → hardcoded defaults (ticket values).
  const targetBaseUrl =
    options.targetBaseUrl ??
    process.env["ACME_HR_BASE_URL"] ??
    "https://api.acme-hr.example.com";

  const targetApiToken =
    options.targetApiToken ?? process.env["ACME_HR_API_TOKEN"];

  const scimAuthToken =
    options.scimAuthToken ?? process.env["SCIM_AUTH_TOKEN"];

  const client = new HttpAcmeHrSystemClient({
    baseUrl: targetBaseUrl,
    ...(targetApiToken !== undefined && { apiToken: targetApiToken }),
  });
  const store = new AcmeHrSystemUserStore(client);

  // Skeleton handles: JSON body parsing, Content-Type, bearer auth at
  // /scim/v2, request-ID middleware, all User CRUD routes, metadata routes,
  // /healthz. We inject our store so the skeleton routes call our
  // client-backed implementation.
  const app = createApp({
    userStore: store,
    ...(scimAuthToken !== undefined && { authToken: scimAuthToken }),
  });

  // --------------------------------------------------------------------------
  // DELETE /scim/v2/Users/:id — soft-delete extension
  //
  // The skeleton's usersRouter omits DELETE (it's optional per the OIN suite).
  // We add it here because ticket required_ops.users_delete=true.
  //
  // SOFT-DELETE POLICY: translate DELETE → PATCH {enabled:false}.
  // Never call client.deleteUser() — row retention is required.
  // okta-dialect.md §3 (deprovisioning semantics, soft_delete row).
  //
  // Auth: the skeleton mounts bearerAuth middleware at /scim/v2 on the
  // returned app instance before we mount this route, so this route is
  // already protected. No second auth check needed.
  //
  // Response: 204 No Content per RFC 7644 §3.6. Okta does not parse the
  // DELETE response body (unlike PATCH — okta-dialect.md §1 which expects
  // 200 + body). So 204 is correct here.
  // --------------------------------------------------------------------------
  app.delete(
    "/scim/v2/Users/:id",
    async (req: Request, res: Response) => {
      try {
        const deactivated = await store.softDelete(req.params["id"]!);
        if (deactivated === null) {
          return res
            .status(404)
            .json(
              scimError(404, `User not found: ${req.params["id"]}`, "noTarget"),
            );
        }
        return res.status(204).send();
      } catch (err) {
        console.error(
          { err, userId: req.params["id"] },
          "Unexpected error in DELETE /scim/v2/Users/:id",
        );
        return res.status(500).json(scimError(500, "Internal server error"));
      }
    },
  );

  return app;
}