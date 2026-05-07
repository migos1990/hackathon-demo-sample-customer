/**
 * Standalone entrypoint for the Acme HR System SCIM Connector.
 *
 * Reads environment variables and starts the Express server.
 * Run via: npx tsx connectors/acme-hr-system/start.ts
 * Or via package.json script: npm run start:acme-hr-system-connector
 *
 * Environment variables (see RUNBOOK.md for full table):
 *   SCIM_AUTH_TOKEN          — required in prod; omit for dev-mode
 *   ACME_HR_API_TOKEN        — required in prod; omit for dev-mode
 *   ACME_HR_SYSTEM_BASE_URL  — target API base URL (defaults to prod URL)
 *   CONNECTOR_PORT           — listen port (default 3003)
 *
 * Ticket: OKT-10
 */

import { createAcmeHrSystemConnector } from "./server.js";

const PORT = Number.parseInt(process.env["CONNECTOR_PORT"] ?? "3003", 10);

// Three-environment base URL ladder per OKT-10 ticket `environments` map:
//   dev:     https://dev.acme-hr.example.com
//   staging: https://staging.acme-hr.example.com
//   prod:    https://api.acme-hr.example.com
// The env var overrides any hardcoded default; omit it to use prod URL.
const TARGET_BASE_URL =
  process.env["ACME_HR_SYSTEM_BASE_URL"] ?? "https://api.acme-hr.example.com";

const SCIM_AUTH_TOKEN = process.env["SCIM_AUTH_TOKEN"];
const API_TOKEN = process.env["ACME_HR_API_TOKEN"]; // OKT-10: auth_credential_env_var

if (!SCIM_AUTH_TOKEN) {
  // Warn loudly — do NOT exit, to allow dev-mode iteration without a token.
  // In production this MUST be set; RUNBOOK.md documents this requirement.
  console.warn(
    "[acme-hr-system] WARNING: SCIM_AUTH_TOKEN is not set. " +
      "All SCIM requests will be accepted without authentication. " +
      "Set this variable before connecting to Okta.",
  );
}

if (!API_TOKEN) {
  console.warn(
    "[acme-hr-system] WARNING: ACME_HR_API_TOKEN is not set. " +
      "Requests to Acme HR System will be unauthenticated. " +
      "Set this variable for staging and production.",
  );
}

const app = createAcmeHrSystemConnector({
  targetBaseUrl: TARGET_BASE_URL,
  ...(API_TOKEN !== undefined && { targetApiToken: API_TOKEN }),
  ...(SCIM_AUTH_TOKEN !== undefined && { scimAuthToken: SCIM_AUTH_TOKEN }),
});

app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "Acme HR System SCIM connector started",
      port: PORT,
      scim_base: `http://localhost:${PORT}/scim/v2`,
      target_base_url: TARGET_BASE_URL,
      auth_enabled: SCIM_AUTH_TOKEN !== undefined,
      target_auth_enabled: API_TOKEN !== undefined,
      lifecycle_policy: "soft_delete",
      ticket: "OKT-10",
    }),
  );
});