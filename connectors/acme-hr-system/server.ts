/**
 * Acme HR System SCIM Connector — application factory.
 *
 * ticket: OKT-10
 * customer: Acme HR System
 * slug: acme-hr-system
 *
 * Composes:
 *   skeleton.createApp (SCIM-facing routes + middleware)
 *     + AcmeHrSystemUserStore (UserStore impl → HttpAcmeHrSystemClient)
 *     + attribute mapping (mapping.ts)
 *     + DELETE soft-delete router extension (routes/users.ts)
 *   = a SCIM 2.0 server Okta can point at
 *
 * Per okta-dialect.md §10: all required endpoints are mounted:
 *   GET    /scim/v2/Users          ← skeleton LIST
 *   POST   /scim/v2/Users          ← skeleton CREATE
 *   GET    /scim/v2/Users/:id      ← skeleton GET
 *   PATCH  /scim/v2/Users/:id      ← skeleton PATCH (deactivation via active:false)
 *   DELETE /scim/v2/Users/:id      ← this connector's soft-delete extension
 *   GET    /scim/v2/ServiceProviderConfig  ← skeleton META
 *   GET    /scim/v2/Schemas               ← skeleton META
 *   GET    /scim/v2/ResourceTypes         ← skeleton META
 *   GET    /scim/v2/healthz               ← skeleton HEALTH
 *
 * Groups are NOT mounted (required_ops.groups absent in OKT-10).
 * patch.supported:true is advertised in /ServiceProviderConfig per
 * okta-dialect.md §10 — the skeleton's meta.ts already sets this.
 *
 * lifecycle_policy: soft_delete — DELETE /Users/:id maps to enabled:false,
 * never a hard delete. Per okta-dialect.md §3.
 */
import type { Application } from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpAcmeHrSystemClient } from "./client.js";
import { AcmeHrSystemUserStore } from "./store.js";
import { acmeHrSystemUsersDeleteRouter } from "./routes/users.js";

export interface CreateAcmeHrSystemConnectorOptions {
  /**
   * Base URL of the Acme HR System target API.
   * Per OKT-10 environments:
   *   dev:     https://dev.acme-hr.example.com
   *   staging: https://staging.acme-hr.example.com
   *   prod:    https://api.acme-hr.example.com
   * Injected at runtime via ACME_HR_BASE_URL env var.
   */
  targetBaseUrl: string;
  /**
   * Bearer token presented to the Acme HR System target API.
   * Per OKT-10 auth_credential_env_var: ACME_HR_API_TOKEN.
   * Omit for dev-mode (no auth). MUST be set in staging and prod.
   */
  targetApiToken?: string;
  /**
   * Bearer token Okta must present to this connector.
   * Injected via SCIM_AUTH_TOKEN env var. Omit for dev-mode.
   * Per okta-dialect.md §9: unauthenticated requests → 401.
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

  const userStore = new AcmeHrSystemUserStore(client);

  // Compose the base SCIM app from the skeleton.
  // The skeleton mounts GET/POST/GET:id/PATCH:id + meta + healthz.
  const app = createApp({
    userStore,
    ...(options.scimAuthToken !== undefined && {
      authToken: options.scimAuthToken,
    }),
  });

  // Mount the connector-specific DELETE soft-delete router on top.
  // Must be mounted AFTER createApp so auth middleware is already in place.
  // The route path is /scim/v2/Users — same prefix as the skeleton's usersRouter;
  // Express resolves the DELETE method to this router since the skeleton does
  // not register a DELETE handler.
  app.use(
    "/scim/v2/Users",
    acmeHrSystemUsersDeleteRouter(userStore),
  );

  return app;
}