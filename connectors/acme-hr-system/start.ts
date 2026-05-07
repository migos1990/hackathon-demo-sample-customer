/**
 * Standalone startup for the Acme HR System SCIM connector.
 *
 * Ticket: OKT-10
 *
 * Usage:
 *   node --experimental-specifier-resolution=node dist/connectors/acme-hr-system/start.js
 *   # or via npm script (add to package.json):
 *   # "start:acme-hr-system-connector": "tsx connectors/acme-hr-system/start.ts"
 *
 * Environment variables (see RUNBOOK.md for full reference):
 *   SCIM_AUTH_TOKEN      Bearer token Okta presents to this connector (required in prod)
 *   ACME_HR_API_TOKEN    Bearer token this connector presents to the target (required in prod)
 *   ACME_HR_BASE_URL     Target API base URL (default: https://api.acme-hr.example.com)
 *   CONNECTOR_PORT       Listen port (default: 3003)
 *
 * Dev-mode: omit SCIM_AUTH_TOKEN and ACME_HR_API_TOKEN — both are optional;
 * auth is a no-op when unset. Never deploy to production without both tokens.
 *
 * okta-dialect.md §9: bearer auth; 401 on missing/invalid token.
 */

import { createAcmeHrSystemConnector } from "./server.js";

const PORT = parseInt(process.env["CONNECTOR_PORT"] ?? "3003", 10);
const TARGET_BASE_URL =
  process.env["ACME_HR_BASE_URL"] ?? "https://api.acme-hr.example.com";
const TARGET_API_TOKEN = process.env["ACME_HR_API_TOKEN"];
const SCIM_AUTH_TOKEN = process.env["SCIM_AUTH_TOKEN"];

if (!TARGET_API_TOKEN) {
  console.warn(
    "[acme-hr-system] ACME_HR_API_TOKEN is not set — running in dev-mode " +
      "(no auth to target). Set this env var before deploying to production.",
  );
}
if (!SCIM_AUTH_TOKEN) {
  console.warn(
    "[acme-hr-system] SCIM_AUTH_TOKEN is not set — running in dev-mode " +
      "(no auth required from Okta). Set this env var before deploying to production.",
  );
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
      scim_base: `http://0.0.0.0:${PORT}/scim/v2`,
      target_base_url: TARGET_BASE_URL,
      auth_configured: Boolean(SCIM_AUTH_TOKEN),
      target_auth_configured: Boolean(TARGET_API_TOKEN),
      ticket: "OKT-10",
    }),
  );
});