/**
 * Standalone entrypoint for the Acme HR System SCIM Connector.
 *
 * Run via:
 *   npm run start:acme-hr-system-connector
 *   (or directly: node --import tsx/esm connectors/acme-hr-system/start.ts)
 *
 * Environment variables resolved here (Law 4 SECRETS-OUT — no secrets
 * in source; all injected at runtime via env):
 *
 *   ACME_HR_SYSTEM_BASE_URL   Base URL for the native API.
 *                             Defaults to https://api.acme-hr.example.com (prod).
 *                             Override for dev:     https://dev.acme-hr.example.com
 *                             Override for staging: https://staging.acme-hr.example.com
 *
 *   ACME_HR_API_TOKEN         Bearer token for the native API.
 *                             REQUIRED in prod. Omit for dev-mode (no auth on target).
 *
 *   SCIM_AUTH_TOKEN           Bearer token Okta presents to this connector.
 *                             REQUIRED in prod. Omit for dev-mode (connector open).
 *
 *   CONNECTOR_PORT            Listen port. Defaults to 3002.
 *
 * Target tenant:  demo-tomato-leopon-10388.oktapreview.com
 * Terraform workspace: staging
 */

import { createAcmeHrSystemConnector } from "./server.js";

const port = parseInt(process.env["CONNECTOR_PORT"] ?? "3002", 10);

const baseUrl = process.env["ACME_HR_SYSTEM_BASE_URL"];
const apiToken = process.env["ACME_HR_API_TOKEN"];
const scimToken = process.env["SCIM_AUTH_TOKEN"];

if (!scimToken) {
  // Warn loudly in non-dev contexts. Not a hard exit — dev mode is valid
  // for local testing, but never ship to staging/prod without a token.
  console.warn(
    "[acme-hr-system-connector] WARNING: SCIM_AUTH_TOKEN is not set. " +
      "Connector is running without authentication. " +
      "Set this env var before connecting to Okta.",
  );
}

if (!apiToken) {
  console.warn(
    "[acme-hr-system-connector] WARNING: ACME_HR_API_TOKEN is not set. " +
      "Requests to the native API will be unauthenticated.",
  );
}

const app = createAcmeHrSystemConnector({
  ...(baseUrl !== undefined && { targetBaseUrl: baseUrl }),
  ...(apiToken !== undefined && { targetApiToken: apiToken }),
  ...(scimToken !== undefined && { scimAuthToken: scimToken }),
});

app.listen(port, () => {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "Acme HR System SCIM connector listening",
      url: `http://localhost:${port}/scim/v2`,
      scim_auth_configured: Boolean(scimToken),
      target_api_auth_configured: Boolean(apiToken),
      target_base_url: baseUrl ?? "https://api.acme-hr.example.com (prod default)",
    }),
  );
});