/**
 * BigCorpHR SCIM Connector — composes the skeleton's createApp with a
 * BigCorpHrUserStore backed by HttpBigCorpHrClient.
 *
 * Architecture:
 *   skeleton (SCIM-facing routes + middleware)
 *     + BigCorpHrUserStore (UserStore impl → BigCorpHR native API)
 *     + mapping.ts (pure attribute transforms)
 *     = a SCIM 2.0 server Okta can provision against
 *
 * Groups: NOT wired (ticket OKT-7 required_ops.groups: false).
 * ServiceProviderConfig in skeleton/routes/meta.ts advertises the server's
 * capabilities honestly — no bulk, no sort, patch.supported: true,
 * filter.supported: true.  The skeleton default is correct as-is.
 *
 * Soft-delete wiring: the skeleton's users router currently handles
 * GET / POST / GET:id / PATCH.  DELETE /Users/:id is extended here via
 * the additionalRoutes hook so BigCorpHrUserStore.deleteUser() is reachable,
 * translating the DELETE into an enabled=false PATCH per the soft_delete
 * policy (okta-dialect.md §3).
 */
import express, { type Application, type Request, type Response, type NextFunction } from "express";
import { createApp } from "../../skeleton/server.js";
import { scimError } from "../../skeleton/middleware/error-envelope.js";
import { HttpBigCorpHrClient } from "./client.js";
import { BigCorpHrUserStore } from "./store.js";

export interface CreateBigCorpHrConnectorOptions {
  /** Base URL of the BigCorpHR native API. */
  targetBaseUrl: string;
  /**
   * Bearer token this connector presents to BigCorpHR.
   * From env BIGCORP_HR_API_TOKEN.  Omit for dev-mode (no auth to target).
   */
  targetApiToken?: string;
  /**
   * Bearer token Okta must present to THIS connector.
   * From env SCIM_AUTH_TOKEN.  Omit for dev-mode only.
   * okta-dialect.md §9.
   */
  scimAuthToken?: string;
}

export function createBigCorpHrConnector(
  options: CreateBigCorpHrConnectorOptions,
): Application {
  const client = new HttpBigCorpHrClient({
    baseUrl: options.targetBaseUrl,
    ...(options.targetApiToken !== undefined && {
      apiToken: options.targetApiToken,
    }),
  });
  const userStore = new BigCorpHrUserStore(client);

  // Compose the skeleton app — handles GET/POST /Users, GET/PATCH /Users/:id,
  // metadata endpoints, auth middleware, healthz.
  const app = createApp({
    userStore,
    ...(options.scimAuthToken !== undefined && {
      authToken: options.scimAuthToken,
    }),
  });

  // -------------------------------------------------------------------------
  // Soft-delete extension: DELETE /scim/v2/Users/:id
  // -------------------------------------------------------------------------
  // The skeleton's usersRouter does not wire DELETE because the lifecycle
  // policy is customer-specific (hard vs soft).  We add it here so this
  // connector satisfies ticket OKT-7 required_ops.users_delete: true while
  // honouring lifecycle_policy: soft_delete.
  //
  // okta-dialect.md §3: "Okta does NOT use DELETE /Users/{id} at all in the
  // standard lifecycle."  The DELETE handler exists for admin-initiated forced
  // removal edge-cases; it produces the same outcome as PATCH active:false
  // (policy consistency per okta-dialect.md §3 "Anti-patterns" bullet).
  app.delete(
    "/scim/v2/Users/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const deleted = await userStore.deleteUser(req.params["id"]!);
        if (deleted === null) {
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
        // Return 204 No Content on successful delete per RFC 7644 §3.6.
        // (Unlike PATCH, Okta does not parse the body on DELETE responses.)
        return res.status(204).send();
      } catch (err) {
        return next(err);
      }
    },
  );

  return app;
}