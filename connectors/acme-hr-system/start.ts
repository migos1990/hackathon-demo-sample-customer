/**
 * Standalone startup for the Acme HR System SCIM Connector.
 *
 * Reads configuration from environment variables (Law 4 SECRETS-OUT —
 * no credentials in source). Starts an Express HTTP server on CONNECTOR_PORT.
 *
 * Usage:
 *   SCIM_AUTH_TOKEN=<token> \
 *   ACME_HR_API_TOKEN=<token> \
 *   ACME_HR_BASE_URL=https://api.acme-hr.example.com \
 *   node --experimental-specifier-resolution=node dist/connectors/acme-hr-system/start.js
 *
 *   # Or via npm script (add to package.json):
 *   "start:acme-hr-system-connector": "tsx connectors/acme-hr-system/start.ts"
 *
 * Environment variables:
 *   SCIM_AUTH_TOKEN      — Bearer token Okta presents to this connector.
 *                          REQUIRED in production. Omit for dev-mode (auth disabled).
 *   ACME_HR_API_TOKEN    — Bearer token this connector presents to Acme HR System.
 *                          REQUIRED in production. Omit for dev-mode.
 *   ACME_HR_BASE_URL     — Base URL of the native API.
 *                          Defaults to https://api.acme-hr.example.com (prod).
 *                          Set to https://dev.acme-hr.example.com for dev,
 *                          https://staging.acme-hr.example.com for staging.
 *   CONNECTOR_PORT       — Listen port. Defaults to 3003.
 *
 * Per ticket OKT-10 environments:
 *   dev:     ACME_HR_BASE_URL=https://dev.acme-hr.example.com
 *   staging: ACME_HR_BASE_URL=https://staging.acme-hr.example.com
 *   prod:    ACME_HR_BASE_URL=https://api.acme-hr.example.com (default)
 */
import { createAcmeHrSystemConnector } from "./server.js";

const PORT = parseInt(process.env["CONNECTOR_PORT"] ?? "3003", 10);
const TARGET_BASE_URL =
  process.env["ACME_HR_BASE_URL"] ?? "https://api.acme-hr.example.com";
const TARGET_API_TOKEN = process.env["ACME_HR_API_TOKEN"];
const SCIM_AUTH_TOKEN = process.env["SCIM_AUTH_TOKEN"];

// Warn (do not abort) when production-critical env vars are absent.
// A hard abort here would break local dev; the RUNBOOK.md enforces the
// requirement for production deployments at the human / Terraform level.
if (!SCIM_AUTH_TOKEN) {
  console.warn(
    "[acme-hr-system-connector] WARNING: SCIM_AUTH_TOKEN is not set. " +
      "The SCIM connector is running WITHOUT authentication. " +
      "This is only acceptable for local development. " +
      "Production deployments MUST set SCIM_AUTH_TOKEN. " +
      "(okta-dialect.md §9: reject unauthenticated requests with 401)",
  );
}
if (!TARGET_API_TOKEN) {
  console.warn(
    "[acme-hr-system-connector] WARNING: ACME_HR_API_TOKEN is not set. " +
      "Calls to the Acme HR System native API will be unauthenticated. " +
      "This is only acceptable for local development.",
  );
}

const app = createAcmeHrSystemConnector({
  targetBaseUrl: TARGET_BASE_URL,
  ...(TARGET_API_TOKEN !== undefined && { targetApiToken: TARGET_API_TOKEN }),
  ...(SCIM_AUTH_TOKEN !== undefined && { scimAuthToken: SCIM_AUTH_TOKEN }),
});

const server = app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      level: "info",
      message: "Acme HR System SCIM connector started",
      port: PORT,
      target_base_url: TARGET_BASE_URL,
      scim_base_path: "/scim/v2",
      auth_enabled: Boolean(SCIM_AUTH_TOKEN),
      target_auth_enabled: Boolean(TARGET_API_TOKEN),
      okta_tenant: "demo-tomato-leopon-10388.oktapreview.com",
      lifecycle_policy: "soft_delete",
      timestamp: new Date().toISOString(),
    }),
  );
});

// Graceful shutdown — let in-flight requests drain before exiting.
// Okta's retry behaviour (okta-dialect.md §9) means a hard kill mid-request
// would trigger a retry storm; a graceful close gives in-flight ops time
// to complete.
function shutdown(signal: string): void {
  console.log(
    JSON.stringify({
      level: "info",
      message: `Received ${signal} — shutting down gracefully`,
      timestamp: new Date().toISOString(),
    }),
  );
  server.close(() => {
    console.log(
      JSON.stringify({
        level: "info",
        message: "HTTP server closed — process exiting",
        timestamp: new Date().toISOString(),
      }),
    );
    process.exit(0);
  });
  // Force exit after 10 s if graceful close stalls.
  setTimeout(() => {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Graceful shutdown timed out — forcing exit",
        timestamp: new Date().toISOString(),
      }),
    );
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));