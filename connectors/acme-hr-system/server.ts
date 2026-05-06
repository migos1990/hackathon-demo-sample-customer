/**
 * Acme HR System SCIM Connector — app factory.
 *
 * Composes:
 *   skeleton createApp()  (SCIM-facing routes + middleware + auth)
 *     + AcmeHrSystemUserStore  (UserStore backed by native API)
 *     + usersDeleteRouter  (soft-delete DELETE /Users/:id)
 *   = a SCIM 2.0 server Okta can point at for the Acme HR System tenant.
 *
 * Environment variables (all resolved at call time — Law 4 SECRETS-OUT):
 *   ACME_HR_SYSTEM_BASE_URL   — native API base URL (defaults to prod)
 *   ACME_HR_API_TOKEN         — bearer token for native API
 *   SCIM_AUTH_TOKEN           — bearer token Okta presents to this connector
 *
 * Target tenant: demo-tomato-leopon-10388.oktapreview.com
 * Terraform workspace: staging
 */

import type { Application } from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpAcmeHrSystemClient } from "./client.js";
import { AcmeHrSystemUserStore } from "./store.js";
import { usersDeleteRouter } from "./routes/users-delete.js";

export interface CreateAcmeHrSystemConnectorOptions {
  /**
   * Base URL of Acme HR System's native API.
   * Defaults to prod: https://api.acme-hr.example.com
   */
  targetBaseUrl?: string;
  /** Bearer token this connector presents to the native API. */
  targetApiToken?: string;
  /** Bearer token Okta must present to this connector. Omit for dev-mode. */
  scimAuthToken?: string;
}

export function createAcmeHrSystemConnector(
  options: CreateAcmeHrSystemConnectorOptions = {},
): Application {
  const baseUrl =
    options.targetBaseUrl ??
    "https://api.acme-hr.example.com"; // prod default per ticket environments map

  const client = new HttpAcmeHrSystemClient({
    baseUrl,
    ...(options.targetApiToken !== undefined && {
      apiToken: options.targetApiToken,
    }),
  });

  const userStore = new AcmeHrSystemUserStore(client);

  const app = createApp({
    userStore,
    ...(options.scimAuthToken !== undefined && {
      authToken: options.scimAuthToken,
    }),
  });

  // Mount the soft-delete DELETE route on top of the skeleton's /Users router.
  // Skeleton mounts /scim/v2/Users — we extend it here with DELETE /:id.
  // The skeleton router handles GET / POST / GET /:id / PATCH /:id.
  app.use("/scim/v2/Users", usersDeleteRouter(userStore));

  return app;
}