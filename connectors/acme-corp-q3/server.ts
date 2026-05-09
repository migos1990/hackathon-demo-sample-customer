/**
 * acme-corp-q3 SCIM Connector — composes the skeleton's createApp with a
 * UserStore backed by HttpAcmeCorpQ3Client, plus a custom DELETE /Users/:id
 * route that enforces the soft_delete lifecycle policy.
 *
 * Architecture — why a pre-skeleton router:
 *   The skeleton's UserStore interface does not define delete(). OKT-60
 *   requires `users_delete: true`. Per okta-dialect.md §3 policy-consistency
 *   rule, both DELETE and PATCH active=false must produce the same end-state
 *   (enabled=false, row retained — never hard-deleted).
 *
 *   We mount a thin Express application as a middleware layer in FRONT of
 *   the skeleton app. The thin layer only handles DELETE /scim/v2/Users/:id.
 *   Every other method/path falls through to the skeleton via next('router').
 *   The skeleton's bearerAuth is applied inside createApp() at /scim/v2 and
 *   covers all routes INCLUDING our DELETE because the thin layer is mounted
 *   on the same outer app AFTER the bearerAuth sub-app.
 *
 * Mount order inside the returned Application:
 *   1. JSON body parser (accepts application/json + application/scim+json)
 *   2. SCIM Content-Type header enforcer
 *   3. Bearer auth (from skeleton's createApp, applied at /scim/v2)
 *   4. Custom DELETE /scim/v2/Users/:id  ← soft_delete policy
 *   5. Skeleton routes (GET, POST, PATCH /scim/v2/Users/*, healthz, metadata)
 *
 * Per okta-dialect.md §9: auth is enforced on every /Users/* and /Groups/*
 * route. The skeleton's bearerAuth middleware covers the full /scim/v2
 * sub-path, so step 4 inherits auth automatically.
 */

import express, { type Application, type Request, type Response, type NextFunction } from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpAcmeCorpQ3Client } from "./client.js";
import { AcmeCorpQ3UserStore } from "./store.js";
import { scimError } from "../../skeleton/middleware/error-envelope.js";

export interface CreateAcmeCorpQ3ConnectorOptions {
  /**
   * Base URL of the Internal HR System target API.
   * Prod: https://api.acme-corp-q3.example.com
   * Dev:  https://api.dev.acme-corp-q3.example.com
   */
  targetBaseUrl: string;
  /**
   * Bearer token the connector presents to the HR system.
   * Source: env ACME_CORP_Q3_API_TOKEN (OKT-60 auth_credential_env_var).
   * Omit only for dev/test — NEVER omit in production.
   */
  targetApiToken?: string;
  /**
   * Bearer token Okta must present to this connector.
   * Source: env SCIM_AUTH_TOKEN.
   * Omit only for dev/test — NEVER omit in production.
   */
  scimAuthToken?: string;
}

export function createAcmeCorpQ3Connector(
  options: CreateAcmeCorpQ3ConnectorOptions,
): Application {
  // --- Wiring ---
  const client = new HttpAcmeCorpQ3Client({
    baseUrl: options.targetBaseUrl,
    ...(options.targetApiToken !== undefined && { apiToken: options.targetApiToken }),
  });
  const userStore = new AcmeCorpQ3UserStore(client);

  // Build the skeleton app. This installs:
  //   - /scim/v2/healthz (auth-exempt)
  //   - SCIM Content-Type header
  //   - bearerAuth at /scim/v2 (covers ALL sub-paths including our DELETE)
  //   - GET+POST+PATCH /scim/v2/Users/*
  //   - GET /scim/v2/ServiceProviderConfig, /Schemas, /ResourceTypes
  const skeletonApp = createApp({
    userStore,
    ...(options.scimAuthToken !== undefined && { authToken: options.scimAuthToken }),
  });

  // --- Custom DELETE route (soft_delete policy — OKT-60) ---
  //
  // Mounted on the skeletonApp so it runs INSIDE the skeleton's bearerAuth
  // boundary. We use a sub-router mounted at /scim/v2/Users and handle only
  // DELETE /:id; all other verbs fall through to the skeleton's own users router.
  //
  // Per okta-dialect.md §3: "Okta's deprovisioning signal is PATCH active=false,
  // NOT DELETE." The DELETE endpoint exists for edge-case admin-initiated removal
  // and must produce the SAME end-state as PATCH active=false (enabled=false,
  // row retained). Both paths call userStore.softDelete() → client.softDeleteUser()
  // → PATCH {enabled: false} on the HR system.
  const deleteRouter = express.Router();

  deleteRouter.delete(
    "/:id",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const updated = await userStore.softDelete(req.params["id"]!);

        if (updated === null) {
          // User not found — return 404 + SCIM error envelope per RFC 7644 §3.12
          // and okta-dialect.md §8. OIN test suite step 22 asserts 404 on unknown id.
          res
            .status(404)
            .json(
              scimError(
                404,
                `User not found: ${req.params["id"]}`,
                "noTarget",
              ),
            );
          return;
        }

        // RFC 7644 §3.6: successful DELETE returns 204 No Content.
        // Okta does not parse the DELETE response body, so 204 is correct here
        // (unlike PATCH where okta-dialect.md §1 requires 200 + body).
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  // Mount the deleteRouter on the skeleton app at /scim/v2/Users.
  // The skeleton app already has bearerAuth protecting /scim/v2, so this
  // route is automatically authenticated.
  skeletonApp.use("/scim/v2/Users", deleteRouter);

  return skeletonApp;
}