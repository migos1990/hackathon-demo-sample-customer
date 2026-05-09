/**
 * Acme Corp Q3 SCIM Connector — app factory.
 *
 * Composes the skeleton's createApp with a UserStore backed by
 * HttpAcmeCorpQ3Client targeting the Internal HR System API.
 *
 * Architecture (mirrors connectors/acme-hr/server.ts):
 *   skeleton (SCIM-facing routes + middleware + auth)
 *     + AcmeCorpQ3UserStore (UserStore impl)
 *         + HttpAcmeCorpQ3Client (HTTP fan-out to HR API)
 *         + mapping.ts (attribute translation)
 *     = a SCIM 2.0 server Okta can point at.
 *
 * The DELETE route is added here (not in the skeleton's usersRouter) because
 * DELETE behaviour is lifecycle-policy-specific. The skeleton routes cover
 * the OIN-gating subset (GET, POST, PATCH); DELETE is connector-level.
 * Soft_delete policy: DELETE → deactivate (PATCH {enabled:false}), never
 * hard-remove. See okta-dialect.md §3 and store.ts delete().
 *
 * Factory-per-app: no module-level state. Tests spin isolated instances.
 * Law 5 BLAST-RADIUS: all dependencies injected; no global singletons.
 */
import express, { type Application, type Request, type Response } from "express";
import { createApp } from "../../skeleton/server.js";
import { HttpAcmeCorpQ3Client } from "./client.js";
import { AcmeCorpQ3UserStore } from "./store.js";
import { scimError } from "../../skeleton/middleware/error-envelope.js";

export interface CreateAcmeCorpQ3ConnectorOptions {
  /**
   * Base URL of the HR API.
   * Defaults to ACME_CORP_Q3_BASE_URL env var, then the prod URL from
   * ticket OKT-54. Law 4 SECRETS-OUT: override via env in all deployments.
   */
  targetBaseUrl?: string;
  /**
   * Bearer token for the HR API.
   * Sourced from ACME_CORP_Q3_API_TOKEN env var (auth_credential_env_var
   * in ticket OKT-54). Law 4 SECRETS-OUT: never hard-code.
   */
  targetApiToken?: string;
  /**
   * Bearer token Okta presents to this connector.
   * Sourced from SCIM_AUTH_TOKEN env var.
   * Omit only in dev/test — production MUST set this.
   * See okta-dialect.md §9 (Authentication) + OIN test suite step 20.
   */
  scimAuthToken?: string;
  /** Injectable fetch for tests. Defaults to Node 20+ global fetch. */
  fetchImpl?: typeof fetch;
}

export function createAcmeCorpQ3Connector(
  options: CreateAcmeCorpQ3ConnectorOptions = {},
): Application {
  const targetBaseUrl =
    options.targetBaseUrl ??
    process.env["ACME_CORP_Q3_BASE_URL"] ??
    "https://api.acme-corp-q3.example.com";

  const targetApiToken =
    options.targetApiToken ?? process.env["ACME_CORP_Q3_API_TOKEN"];

  const scimAuthToken =
    options.scimAuthToken ?? process.env["SCIM_AUTH_TOKEN"];

  const client = new HttpAcmeCorpQ3Client({
    baseUrl: targetBaseUrl,
    ...(targetApiToken !== undefined && { apiToken: targetApiToken }),
    ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
  });

  const userStore = new AcmeCorpQ3UserStore(client);

  // Build the base skeleton app (SCIM routes: GET list, GET by id, POST, PATCH).
  const app = createApp({
    userStore,
    ...(scimAuthToken !== undefined && { authToken: scimAuthToken }),
  });

  // ── DELETE /scim/v2/Users/:id ──────────────────────────────────────────────
  // Soft_delete policy (ticket OKT-54): DELETE → deactivate.
  // okta-dialect.md §3: Okta normally uses PATCH active:false, not DELETE.
  // This route exists to satisfy required_ops.users_delete:true and to handle
  // any admin-initiated hard-remove request — but it enforces the soft_delete
  // contract by delegating to store.delete() which writes {enabled:false}.
  //
  // Auth: the skeleton's bearerAuth middleware (mounted at /scim/v2 in
  // createApp) already covers this path — no additional auth needed here.
  app.delete(
    "/scim/v2/Users/:id",
    async (req: Request, res: Response) => {
      try {
        const found = await userStore.delete(req.params["id"]!);
        if (!found) {
          return res
            .status(404)
            .json(
              scimError(404, `User not found: ${req.params["id"]}`, "noTarget"),
            );
        }
        // RFC 7644 §3.6: successful DELETE returns 204 No Content.
        // (Unlike PATCH, Okta does not parse the DELETE response body.)
        return res.status(204).send();
      } catch (err) {
        // Unexpected errors propagate to Express default error handler.
        // In production, wire an error-logging middleware above this.
        console.error("[acme-corp-q3] DELETE /Users/:id error", err);
        return res
          .status(500)
          .json(
            scimError(
              500,
              "Internal server error processing DELETE. See connector logs.",
            ),
          );
      }
    },
  );

  return app;
}