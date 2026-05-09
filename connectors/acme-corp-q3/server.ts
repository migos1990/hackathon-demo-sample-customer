/**
 * AcmeCorpQ3 SCIM Connector — application factory.
 *
 * Composes:
 *   skeleton.createApp (SCIM-facing routes + middleware)
 *   + AcmeCorpQ3UserStore (translates UserStore calls to native API)
 *   + AcmeCorpQ3Client (HTTP client for the customer's HR system)
 *
 * The factory pattern mirrors connectors/acme-hr/server.ts. No singletons,
 * no module-level state — each call returns a fresh Express Application.
 * This lets tests spin up isolated instances.
 *
 * Auth:
 *   - scimAuthToken: Bearer token Okta must present to this connector.
 *     Sourced from SCIM_AUTH_TOKEN env var at startup (see start.ts).
 *     docs/okta-dialect.md §9.
 *   - targetApiToken: Bearer token this connector presents to AcmeCorpQ3.
 *     Sourced from ACME_CORP_Q3_API_TOKEN env var (OKT-57).
 *     Connector Law 4 SECRETS-OUT — no tokens in this file.
 */
import type { Application } from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpAcmeCorpQ3Client, type Logger } from "./client.js";
import { AcmeCorpQ3UserStore } from "./store.js";

export interface CreateAcmeCorpQ3ConnectorOptions {
  /**
   * Base URL of the AcmeCorpQ3 HR API.
   * Dev default: https://api.dev.acme-corp-q3.example.com (OKT-57 environments.dev).
   * Prod: https://api.acme-corp-q3.example.com (OKT-57 base_url).
   */
  targetBaseUrl: string;
  /**
   * Bearer token this connector presents to the AcmeCorpQ3 native API.
   * From ACME_CORP_Q3_API_TOKEN env var. Omit for dev open-endpoint mode.
   * OKT-57: auth_credential_env_var = ACME_CORP_Q3_API_TOKEN.
   */
  targetApiToken?: string;
  /**
   * Bearer token Okta must present to this connector's SCIM endpoints.
   * From SCIM_AUTH_TOKEN env var. Omit for dev only.
   * docs/okta-dialect.md §9 — OIN step 20 asserts 401 on missing/bad token.
   */
  scimAuthToken?: string;
  /**
   * Structured logger injected here so the client can emit correlated logs.
   * Defaults to console-JSON in start.ts. Connector Law 8 OBSERVABLE.
   */
  logger?: Logger;
}

export function createAcmeCorpQ3Connector(
  options: CreateAcmeCorpQ3ConnectorOptions,
): Application {
  const client = new HttpAcmeCorpQ3Client({
    baseUrl: options.targetBaseUrl,
    ...(options.targetApiToken !== undefined && {
      apiToken: options.targetApiToken,
    }),
    ...(options.logger !== undefined && { logger: options.logger }),
  });

  const userStore = new AcmeCorpQ3UserStore(client);

  return createApp({
    userStore,
    ...(options.scimAuthToken !== undefined && {
      authToken: options.scimAuthToken,
    }),
  });
}