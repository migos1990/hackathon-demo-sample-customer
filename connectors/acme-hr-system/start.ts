/**
 * Standalone entrypoint — Acme HR System SCIM Connector (OKT-10).
 *
 * Reads configuration from environment variables (never from hardcoded values
 * — Connector Law 4 SECRETS-OUT). See RUNBOOK.md §Environment Variables for
 * the full variable reference.
 *
 * Usage:
 *   node --loader ts-node/esm connectors/acme-hr-system/start.ts
 * or, via npm script (add to package.json):
 *   "start:acme-hr-system-connector": "tsx connectors/acme-hr-system/start.ts"
 */
import { createAcmeHrSystemConnector } from "./server.js";

const PORT = parseInt(process.env["CONNECTOR_PORT"] ?? "3003", 10);

// ACME_HR_BASE_URL: customer API endpoint. Defaults to prod URL from ticket.
// Override per environment:
//   dev:     https://dev.acme-hr.example.com
//   staging: https://staging.acme-hr.example.com
//   prod:    https://api.acme-hr.example.com
const TARGET_BASE_URL =
  process.env["ACME_HR_BASE_URL"] ?? "https://api.acme-hr.example.com";

// ACME_HR_API_TOKEN: bearer token this connector presents to the customer's
// API. Required in staging + prod. Omit only in local dev (no auth mode).
const TARGET_API_TOKEN = process.env["ACME_HR_API_TOKEN"];

// SCIM_AUTH_TOKEN: bearer token Okta must present to this connector.
// Required in staging + prod. Omit only in local dev.
const SCIM_AUTH_TOKEN = process.env["SCIM_AUTH_TOKEN"];

if (
  process.env["NODE_ENV"] === "production" &&
  (!TARGET_API_TOKEN || !SCIM_AUTH_TOKEN)
) {
  console.error(
    "FATAL: ACME_HR_API_TOKEN and SCIM_AUTH_TOKEN must be set in production. " +
      "See connectors/acme-hr-system/RUNBOOK.md §Environment Variables.",
  );
  process.exit(1);
}

const app = createAcmeHrSystemConnector({
  targetBaseUrl: TARGET_BASE_URL,
  ...(TARGET_API_TOKEN !== undefined && { targetApiToken: TARGET_API_TOKEN }),
  ...(SCIM_AUTH_TOKEN !== undefined && { scimAuthToken: SCIM_AUTH_TOKEN }),
});

app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "Acme HR System SCIM connector started",
      connector: "acme-hr-system",
      ticket: "OKT-10",
      target_okta_tenant: "demo-tomato-leopon-10388.oktapreview.com",
      scim_base_url: `http://0.0.0.0:${PORT}/scim/v2`,
      target_base_url: TARGET_BASE_URL,
      auth_configured: {
        scim: SCIM_AUTH_TOKEN !== undefined,
        target: TARGET_API_TOKEN !== undefined,
      },
      lifecycle_policy: "soft_delete",
      time: new Date().toISOString(),
    }),
  );
});