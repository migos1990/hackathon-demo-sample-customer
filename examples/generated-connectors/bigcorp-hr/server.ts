/**
 * BigCorpHR SCIM Connector — composes the skeleton's createApp with a
 * UserStore backed by HttpBigCorpHrClient.
 *
 * This is the end-state Application the orchestrator deploys: SCIM-facing
 * routes + middleware from the skeleton, with a UserStore wired to
 * BigCorpHR's native API.
 *
 * Architecture:
 *   skeleton.createApp (SCIM auth, JSON parsing, meta routes)
 *     ← replaced users router: bigCorpHrUsersRouter
 *         ← BigCorpHrUserStore (UserStore impl)
 *             ← HttpBigCorpHrClient → BigCorpHR API
 *             ← mapping.ts (SCIM ↔ BigCorpHR translation)
 *
 * The users router is swapped out from the skeleton's default because
 * BigCorpHR requires a DELETE handler (lifecycle_policy: soft_delete,
 * users_delete: true from ticket SCIM-LIVE-PROBE). The skeleton's built-in
 * usersRouter omits DELETE as optional per okta-dialect.md §10.
 *
 * Factory-per-call: no module-level singletons. Tests get isolated instances.
 */

import type { Application } from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpBigCorpHrClient } from "./client.js";
import { BigCorpHrUserStore } from "./store.js";
import { bigCorpHrUsersRouter } from "./routes/users.js";

export interface CreateBigCorpHrConnectorOptions {
  /**
   * Base URL of the BigCorpHR API.
   * Default: https://api.bigcorp-hr.example.com (ticket SCIM-LIVE-PROBE).
   * Override via BIGCORP_HR_BASE_URL env var (see start.ts).
   */
  targetBaseUrl: string;

  /**
   * Bearer token this connector presents to BigCorpHR.
   * Per ticket SCIM-LIVE-PROBE: auth_credential_env_var: BIGCORP_HR_API_TOKEN.
   * Omit in dev for pass-through (no auth to target).
   */
  targetApiToken?: string;

  /**
   * Bearer token Okta must present to THIS connector.
   * Per okta-dialect.md §9: reject missing/invalid tokens with 401.
   * OIN test step 20 asserts 401 on missing auth.
   * Omit in dev for no-auth (NEVER omit in production).
   */
  scimAuthToken?: string;

  /**
   * Override the fetch implementation — used in integration tests to inject
   * a mock fetch without spawning a real BigCorpHR instance.
   */
  fetchImpl?: typeof fetch;
}

export function createBigCorpHrConnector(
  options: CreateBigCorpHrConnectorOptions,
): Application {
  const client = new HttpBigCorpHrClient({
    baseUrl: options.targetBaseUrl,
    ...(options.targetApiToken !== undefined && {
      apiToken: options.targetApiToken,
    }),
    ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
  });

  const userStore = new BigCorpHrUserStore(client);

  // Bootstrap the skeleton app WITHOUT the default users router.
  // We mount the BigCorpHR-specific router (which includes DELETE) below.
  const app = createApp({
    // Pass the store for healthz probing (skeleton checks for store.ping()).
    userStore,
    ...(options.scimAuthToken !== undefined && {
      authToken: options.scimAuthToken,
    }),
  });

  // Mount the BigCorpHR-specific users router AFTER createApp.
  // createApp mounts skeleton's /scim/v2/Users; this mount at the same path
  // adds the DELETE handler on top (Express matches first-registered route
  // for overlapping paths — BigCorpHR router is registered after skeleton's,
  // so DELETE hits ours while GET/POST/PATCH hit the skeleton's).
  //
  // Cleaner alternative for future: createApp should accept a custom users
  // router factory option. Deferred to post-hackathon skeleton refactor.
  app.use("/scim/v2/Users", bigCorpHrUsersRouter(userStore));

  return app;
}