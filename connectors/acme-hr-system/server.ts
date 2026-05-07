/**
 * Acme HR System SCIM Connector — composes the skeleton's createApp with
 * a UserStore backed by HttpAcmeHrSystemClient.
 *
 * Ticket: OKT-10
 *
 * This is the end-state binary:
 *   skeleton (SCIM-facing routes + middleware)
 *     + AcmeHrSystemUserStore (target-app-facing)
 *     + attribute mapping (pure)
 *     = a SCIM 2.0 server Okta can point at.
 *
 * Factory-per-app mirrors the skeleton convention (no module-level state;
 * tests spin up isolated instances). Standalone startup lives in start.ts.
 *
 * Auth model (okta-dialect.md §9):
 *   • Okta → connector:  bearer token in SCIM_AUTH_TOKEN env var
 *   • connector → target: bearer token in ACME_HR_API_TOKEN env var
 *   Both tokens are optional in dev-mode (when undefined, auth is a no-op
 *   in the skeleton middleware and the client omits the Authorization header).
 *   Production deployments MUST set both. See RUNBOOK.md §Environment variables.
 *
 * The SCIM DELETE route is augmented here to call store.softDelete() instead
 * of a hard-delete, honouring the ticket's lifecycle_policy=soft_delete.
 * okta-dialect.md §3.
 */

import express, {
  type Application,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpAcmeHrSystemClient } from "./client.js";
import { AcmeHrSystemUserStore } from "./store.js";
import { scimError } from "../../skeleton/middleware/error-envelope.js";

export interface CreateAcmeHrSystemConnectorOptions {
  /** Base URL of the Acme HR System target API. */
  targetBaseUrl: string;
  /** Bearer token the connector presents to the target. Omit for dev-mode. */
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

  // Build the base SCIM app with user store + auth.
  const app = createApp({
    userStore,
    ...(options.scimAuthToken !== undefined && {
      authToken: options.scimAuthToken,
    }),
  });

  // -------------------------------------------------------------------
  // Soft-delete override for DELETE /scim/v2/Users/:id
  //
  // The skeleton's createApp does not mount a DELETE handler (DELETE is
  // optional per okta-dialect.md §10 and the skeleton only gates on
  // required OIN ops). We mount it here so that if Okta or an admin does
  // issue a DELETE, the soft_delete policy is honoured.
  //
  // lifecycle_policy=soft_delete (OKT-10): DELETE → PATCH enabled=false,
  // NOT a hard delete call to the target. okta-dialect.md §3.
  //
  // Must be mounted AFTER createApp so auth middleware is already in place.
  // -------------------------------------------------------------------
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
        // RFC 7644 §3.6 allows 204 on DELETE. We return 204 (no body)
        // because Okta does not parse the DELETE response body. The
        // soft-delete is complete; the row still exists on the target with
        // enabled=false.
        return res.status(204).send();
      } catch (err) {
        return next(err);
      }
    },
  );

  return app;
}