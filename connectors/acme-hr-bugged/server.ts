/**
 * Bugged AcmeHR SCIM Connector — server factory.
 *
 * DELIBERATELY BUGGED. See store.ts header for the failure mode.
 *
 * Ships to pre-prod as part of the gate-refusal demo flow. The pre-prod
 * verify gate MUST refuse this — that refusal is the demo's wow.
 *
 * Interface identical to connectors/acme-hr/server.ts so operator scripts
 * don't need a special invocation.
 */
import type { Application } from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpAcmeHrClient } from "../acme-hr/client.js";
import { BuggyAcmeHrUserStore } from "./store.js";

export interface CreateBuggedConnectorOptions {
  targetBaseUrl: string;
  targetApiToken?: string;
  scimAuthToken?: string;
}

export function createBuggedAcmeHrConnector(options: CreateBuggedConnectorOptions): Application {
  const client = new HttpAcmeHrClient({
    baseUrl: options.targetBaseUrl,
    ...(options.targetApiToken !== undefined && { apiToken: options.targetApiToken }),
  });
  const userStore = new BuggyAcmeHrUserStore(client);

  return createApp({
    userStore,
    ...(options.scimAuthToken !== undefined && { authToken: options.scimAuthToken }),
  });
}
