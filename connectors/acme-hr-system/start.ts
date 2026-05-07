/**
 * Standalone HTTP server entrypoint for the Acme HR System SCIM connector
 * (OKT-10).
 *
 * Usage:
 *   tsx connectors/acme-hr-system/start.ts
 *   # or via npm script: npm run start:acme-hr-system
 *
 * Environment variables (see RUNBOOK.md §Environment Variables):
 *   SCIM_AUTH_TOKEN         — Bearer token Okta presents to this connector.
 *                             REQUIRED in production. Omit for dev-mode only.
 *   ACME_HR_API_TOKEN       — Bearer token this connector presents to Acme HR.
 *                             REQUIRED in production. Omit for dev-mode only.
 *   ACME_HR_BASE_URL        — Target API base URL.
 *                             Default: https://api.acme-hr.example.com
 *   CONNECTOR_PORT          — TCP port to listen on. Default: 3003.
 *
 * Startup logs emitted to stdout as structured JSON so they land cleanly in
 * CloudWatch / Loki / Datadog log pipelines (Connector Law 8 OBSERVABLE).
 * The auth-token presence is logged (not the value) so operators can verify
 * configuration without leaking secrets.
 */

import { createAcmeHrSystemConnector } from "./server.js";

const PROD_BASE_URL = "https://api.acme-hr.example.com";

const targetBaseUrl =
  process.env["ACME_HR_BASE_URL"] ?? PROD_BASE_URL;
const targetApiToken = process.env["ACME_HR_API_TOKEN"]; // undefined = dev-mode
const scimAuthToken = process.env["SCIM_AUTH_TOKEN"];     // undefined = dev-mode
const port = Number.parseInt(process.env["CONNECTOR_PORT"] ?? "3003", 10);

// Warn loudly when running without auth in a non-dev context.
// (Can't tell for certain it's prod, but the base URL being the prod URL
//  is a reasonable heuristic.)
if (!scimAuthToken && targetBaseUrl === PROD_BASE_URL) {
  console.error(
    JSON.stringify({
      level: "error",
      msg: "SCIM_AUTH_TOKEN is not set but ACME_HR_BASE_URL points to production. " +
        "All incoming requests will be unauthenticated. Set SCIM_AUTH_TOKEN.",
      acme_hr_base_url: targetBaseUrl,
    }),
  );
}

const app = createAcmeHrSystemConnector({
  targetBaseUrl,
  ...(targetApiToken !== undefined && { targetApiToken }),
  ...(scimAuthToken !== undefined && { scimAuthToken }),
});

app.listen(port, () => {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "Acme HR System SCIM connector listening",
      url: `http://localhost:${port}/scim/v2`,
      target: targetBaseUrl,
      scim_auth_configured: scimAuthToken !== undefined,
      target_auth_configured: targetApiToken !== undefined,
      okta_tenant: "demo-tomato-leopon-10388.oktapreview.com",
      ticket: "OKT-10",
    }),
  );
});