/**
 * Standalone entrypoint for the Acme HR System SCIM Connector.
 *
 * Usage:
 *   node --import tsx/esm connectors/acme-hr-system/start.ts
 *   # or via package.json script:
 *   npm run start:acme-hr-system-connector
 *
 * Required env vars (production):
 *   SCIM_AUTH_TOKEN     — bearer token Okta presents to this connector
 *   ACME_HR_API_TOKEN   — bearer token this connector presents to the API
 *
 * Optional env vars:
 *   ACME_HR_BASE_URL    — override the target API URL (defaults to prod)
 *   CONNECTOR_PORT      — listen port (defaults to 3003)
 *   NODE_ENV            — set to "production" in prod deployments
 *
 * Per ticket environments:
 *   dev:     ACME_HR_BASE_URL=https://dev.acme-hr.example.com
 *   staging: ACME_HR_BASE_URL=https://staging.acme-hr.example.com
 *   prod:    ACME_HR_BASE_URL=https://api.acme-hr.example.com  (default)
 *
 * Security note: in production both tokens MUST be set. The process
 * exits with a non-zero code if SCIM_AUTH_TOKEN is absent in non-dev
 * mode so the deployment pipeline catches misconfiguration.
 * okta-dialect.md §9.
 */

import { createAcmeHrSystemConnector } from "./server.js";

const NODE_ENV = process.env["NODE_ENV"] ?? "development";
const isDev = NODE_ENV === "development" || NODE_ENV === "test";

// --- Startup guard ---
// Reject missing auth tokens in non-dev environments so a mis-configured
// staging or prod deployment fails loudly at boot rather than silently
// accepting unauthenticated Okta requests.
if (!isDev) {
  if (!process.env["SCIM_AUTH_TOKEN"]) {
    console.error(
      "FATAL: SCIM_AUTH_TOKEN is not set. " +
        "This connector must not run without authentication in non-dev mode. " +
        "Set SCIM_AUTH_TOKEN to a ≥32-character secret. " +
        "okta-dialect.md §9 (OIN test suite step 20).",
    );
    process.exit(1);
  }
  if (!process.env["ACME_HR_API_TOKEN"]) {
    console.error(
      "FATAL: ACME_HR_API_TOKEN is not set. " +
        "The connector cannot authenticate to the Acme HR System API. " +
        "Set ACME_HR_API_TOKEN to the API credential. " +
        "Ticket auth_credential_env_var=ACME_HR_API_TOKEN.",
    );
    process.exit(1);
  }
}

const port = parseInt(process.env["CONNECTOR_PORT"] ?? "3003", 10);

const app = createAcmeHrSystemConnector();

app.listen(port, () => {
  const baseUrl = process.env["ACME_HR_BASE_URL"] ?? "https://api.acme-hr.example.com";
  console.log(
    JSON.stringify({
      event: "connector_started",
      connector: "acme-hr-system",
      scim_base: `http://localhost:${port}/scim/v2`,
      target_base_url: baseUrl,
      environment: NODE_ENV,
      auth_enabled: !isDev && !!process.env["SCIM_AUTH_TOKEN"],
      okta_tenant: "demo-tomato-leopon-10388.oktapreview.com",
    }),
  );
});

// --- Graceful shutdown ---
// Okta's SCIM client may retry in-flight requests; give the server a
// chance to drain before exiting.
function shutdown(signal: string): void {
  console.log(JSON.stringify({ event: "shutdown_signal", signal }));
  // For the current in-process connector there is no open connection pool
  // to drain (the HttpAcmeHrSystemClient uses native fetch which manages
  // its own connections). Future versions with a database pool should close
  // it here before exiting.
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));