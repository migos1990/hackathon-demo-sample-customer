/**
 * AcmeCorpQ3 SCIM Connector — application factory.
 *
 * Composes:
 *   1. skeleton/server.ts (createApp) — SCIM-facing routes + middleware
 *      - GET/POST  /scim/v2/Users
 *      - GET/PATCH /scim/v2/Users/:id
 *      - GET       /scim/v2/ServiceProviderConfig
 *      - GET       /scim/v2/Schemas
 *      - GET       /scim/v2/ResourceTypes
 *      - GET       /scim/v2/healthz
 *   2. AcmeCorpQ3UserStore — translates SCIM calls → mapping.ts → client.ts
 *   3. acmeCorpQ3ExtensionRouter — DELETE /scim/v2/Users/:id (soft-delete)
 *
 * The store is injected into both (1) and (3) so the same instance handles
 * all user operations — consistent lifecycle state.
 *
 * Auth: bearer token guard (skeleton/middleware/auth.ts) is configured via
 * the scimAuthToken option. Token is consumed from env in start.ts only
 * (SECRETS-OUT law — no process.env reads in this file).
 */

import type { Application } from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpAcmeCorpQ3Client } from "./client.js";
import { AcmeCorpQ3UserStore } from "./store.js";
import { acmeCorpQ3ExtensionRouter } from "./routes.js";

export interface CreateAcmeCorpQ3ConnectorOptions {
  /**
   * Base URL of the AcmeCorpQ3 HR API.
   * Prod:    https://api.acme-corp-q3.example.com
   * Staging: https://api.dev.acme-corp-q3.example.com
   */
  targetBaseUrl: string;

  /**
   * Bearer token the connector presents to AcmeCorpQ3 API.
   * From env var ACME_CORP_Q3_API_TOKEN (ticket OKT-57 auth_credential_env_var).
   * Omit for dev-mode (no auth header sent to target).
   */
  targetApiToken?: string;

  /**
   * Bearer token Okta must present to this connector.
   * From env var SCIM_AUTH_TOKEN.
   * Omit for dev-mode (disables auth — dev convenience only, never in prod).
   */
  scimAuthToken?: string;

  /**
   * Override fetch implementation for testing.
   * Defaults to global fetch (Node 20+).
   */
  fetchImpl?: typeof fetch;
}

export function createAcmeCorpQ3Connector(
  options: CreateAcmeCorpQ3ConnectorOptions,
): Application {
  const client = new HttpAcmeCorpQ3Client({
    baseUrl: options.targetBaseUrl,
    ...(options.targetApiToken !== undefined && { apiToken: options.targetApiToken }),
    ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
  });

  const userStore = new AcmeCorpQ3UserStore(client);

  // Build the skeleton Express app with the store injected.
  const app = createApp({
    userStore,
    ...(options.scimAuthToken !== undefined && { authToken: options.scimAuthToken }),
  });

  // Mount the soft-delete extension router under /scim/v2/Users.
  // Order matters: extension router is mounted AFTER createApp so the
  // bearerAuth middleware (applied to /scim/v2 in createApp) already runs.
  // Express routes are matched in registration order; the extension adds a
  // DELETE handler that the skeleton doesn't provide.
  app.use("/scim/v2/Users", acmeCorpQ3ExtensionRouter(userStore));

  return app;
}