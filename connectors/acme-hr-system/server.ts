/**
 * Acme HR System SCIM Connector — Express application factory.
 *
 * Composes skeleton.createApp (SCIM-facing routes + middleware) with a
 * UserStore backed by HttpAcmeHrSystemClient (native API) and
 * AcmeHrSystemUserStore (mapping + soft-delete logic).
 *
 * This is the single artifact that is promoted through environments.
 * The factory pattern lets staging and prod spin up isolated instances
 * from the same module with different environment-bound config.
 *
 * Auth:
 *   - Okta → this connector: SCIM_AUTH_TOKEN bearer (okta-dialect.md §9)
 *   - This connector → Acme HR System: ACME_HR_API_TOKEN bearer
 *     (OKT-10 auth_credential_env_var)
 *
 * Environments (OKT-10):
 *   dev:     https://dev.acme-hr.example.com
 *   staging: https://staging.acme-hr.example.com
 *   prod:    https://api.acme-hr.example.com
 *
 * The active target URL is resolved from ACME_HR_BASE_URL at runtime so
 * the same binary deploys to all three environments with no code change.
 *
 * Citations:
 *   - okta-dialect.md §9 (authentication)
 *   - okta-dialect.md §10 (required endpoints)
 */
import type { Application } from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpAcmeHrSystemClient } from "./client.js";
import { AcmeHrSystemUserStore } from "./store.js";

export interface CreateAcmeHrSystemConnectorOptions {
  /**
   * Base URL of the Acme HR System native API.
   * Typically resolved from ACME_HR_BASE_URL env var; see start.ts.
   * Defaults to prod URL from ticket OKT-10 when unset.
   */
  targetBaseUrl?: string;
  /**
   * Bearer token presented to the Acme HR System API.
   * From ACME_HR_API_TOKEN env var. Omit for dev-mode (no target auth).
   */
  targetApiToken?: string;
  /**
   * Bearer token Okta must present to this connector.
   * From SCIM_AUTH_TOKEN env var. Omit for dev-mode (no SCIM auth).
   * Production MUST set this — enforced in RUNBOOK.md.
   * okta-dialect.md §9.
   */
  scimAuthToken?: string;
  /**
   * Inject a custom fetch implementation (primarily for integration tests).
   * Defaults to the ambient global fetch in Node 20+.
   */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TARGET_BASE_URL = "https://api.acme-hr.example.com";

export function createAcmeHrSystemConnector(
  options: CreateAcmeHrSystemConnectorOptions = {},
): Application {
  const targetBaseUrl =
    options.targetBaseUrl ?? DEFAULT_TARGET_BASE_URL;

  const client = new HttpAcmeHrSystemClient({
    baseUrl: targetBaseUrl,
    ...(options.targetApiToken !== undefined && {
      apiToken: options.targetApiToken,
    }),
    ...(options.fetchImpl !== undefined && {
      fetchImpl: options.fetchImpl,
    }),
  });

  const userStore = new AcmeHrSystemUserStore(client);

  return createApp({
    userStore,
    ...(options.scimAuthToken !== undefined && {
      authToken: options.scimAuthToken,
    }),
  });
}