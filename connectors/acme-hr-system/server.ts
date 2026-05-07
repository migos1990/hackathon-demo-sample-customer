/**
 * Acme HR System SCIM Connector — application factory (OKT-10).
 *
 * Composes:
 *   skeleton/server.ts  createApp()       — SCIM-facing routes + middleware
 *   AcmeHrSystemUserStore                 — UserStore backed by the target API
 *   deleteRouter()                        — DELETE /Users/:id (soft-delete)
 *
 * This is the end-state binary: a fully wired Express Application that
 * Okta can point its SCIM provisioning at.
 *
 * Target: https://api.acme-hr.example.com (prod)
 *         https://staging.acme-hr.example.com (staging)
 *         https://dev.acme-hr.example.com (dev)
 *
 * Authentication:
 *   - Okta → this connector: SCIM_AUTH_TOKEN (bearer)
 *   - This connector → Acme HR System: ACME_HR_API_TOKEN (bearer)
 *
 * Factory-per-app mirrors skeleton convention. Standalone startup: start.ts.
 * Tests inject options directly without starting a real HTTP server.
 */

import type { Application } from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpAcmeHrSystemClient } from "./client.js";
import { AcmeHrSystemUserStore } from "./store.js";
import { deleteRouter } from "./routes/users.js";

export interface CreateAcmeHrSystemConnectorOptions {
  /**
   * Base URL of the Acme HR System target API.
   * Resolved from ACME_HR_BASE_URL env var in start.ts.
   * Defaults to https://api.acme-hr.example.com (prod).
   */
  targetBaseUrl: string;

  /**
   * Bearer token the connector presents to Acme HR System.
   * Maps to ACME_HR_API_TOKEN env var. Omit for dev-mode (no auth header).
   */
  targetApiToken?: string;

  /**
   * Bearer token Okta must present to this connector.
   * Maps to SCIM_AUTH_TOKEN env var. Omit for dev-mode (no auth enforced).
   * Production MUST set this — OIN step 20 asserts 401 on missing token.
   * okta-dialect.md §9.
   */
  scimAuthToken?: string;

  /**
   * Override the fetch implementation (injected in tests to avoid real HTTP).
   * Defaults to Node 20+ global fetch.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Create and wire the full Acme HR System SCIM connector.
 *
 * Returns a configured Express Application ready to listen. The caller
 * (start.ts or test harness) calls app.listen() — this factory does not
 * bind a port.
 */
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

  const store = new AcmeHrSystemUserStore(client);

  // Base app from skeleton — provides LIST, CREATE, GET, PATCH on /Users
  // plus metadata endpoints and bearer auth middleware.
  const app = createApp({
    userStore: store,
    ...(options.scimAuthToken !== undefined && {
      authToken: options.scimAuthToken,
    }),
  });

  // Extend with DELETE /Users/:id (soft-delete). Mounted AFTER the skeleton
  // router so Express processes GET/POST/PATCH via the skeleton first;
  // the DELETE verb falls through to this router.
  app.use("/scim/v2/Users", deleteRouter(store));

  return app;
}