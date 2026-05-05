/**
 * AcmeHR SCIM Connector — composes the skeleton's createApp with a
 * UserStore backed by HttpAcmeHrClient.
 *
 * This IS the end-state binary the AI agent will generate per customer:
 *   skeleton (SCIM-facing routes + middleware)
 *     + UserStore impl that talks to the customer's target app
 *     + attribute mapping
 *     = a SCIM server Okta can point at.
 *
 * Factory-per-app mirrors the skeleton convention. Standalone startup is
 * in `start.ts` — run via `npm run start:acme-hr-connector`.
 */
import type { Application } from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpAcmeHrClient } from "./client.js";
import { AcmeHrUserStore } from "./store.js";

export interface CreateConnectorOptions {
  /** Base URL of the AcmeHR target-app API (e.g. http://localhost:4001). */
  targetBaseUrl: string;
  /** Bearer token the connector presents to AcmeHR. Omit for dev-mode. */
  targetApiToken?: string;
  /** Bearer token Okta must present to this connector. Omit for dev-mode. */
  scimAuthToken?: string;
}

export function createAcmeHrConnector(options: CreateConnectorOptions): Application {
  const client = new HttpAcmeHrClient({
    baseUrl: options.targetBaseUrl,
    ...(options.targetApiToken !== undefined && { apiToken: options.targetApiToken }),
  });
  const userStore = new AcmeHrUserStore(client);

  return createApp({
    userStore,
    ...(options.scimAuthToken !== undefined && { authToken: options.scimAuthToken }),
  });
}
