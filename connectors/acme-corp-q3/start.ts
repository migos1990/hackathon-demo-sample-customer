/**
 * Standalone entrypoint for the acme-corp-q3 SCIM connector.
 *
 * Reads configuration from environment variables. All secrets come from env;
 * no hard-coded credentials anywhere in this file (Connector Law 4 SECRETS-OUT).
 *
 * Environment variables:
 *   SCIM_AUTH_TOKEN          — Bearer token Okta presents to this connector (required in prod)
 *   ACME_CORP_Q3_API_TOKEN   — Bearer token this connector presents to the HR system (required in prod)
 *   ACME_CORP_Q3_BASE_URL    — HR system API base URL (defaults to prod URL from OKT-60)
 *   CONNECTOR_PORT           — Listen port (defaults to 3003)
 *
 * Usage:
 *   npx tsx connectors/acme-corp-q3/start.ts
 *   # or via npm script: npm run start:acme-corp-q3-connector
 */

import { createAcmeCorpQ3Connector } from "./server.js";

const PORT = parseInt(process.env["CONNECTOR_PORT"] ?? "3003", 10);

const targetBaseUrl =
  process.env["ACME_CORP_Q3_BASE_URL"] ??
  "https://api.acme-corp-q3.example.com";

const targetApiToken = process.env["ACME_CORP_Q3_API_TOKEN"];
const scimAuthToken = process.env["SCIM_AUTH_TOKEN"];

if (!targetApiToken) {
  console.warn(
    "[acme-corp-q3] WARNING: ACME_CORP_Q3_API_TOKEN is not set. " +
      "Requests to the HR system will be unauthenticated. " +
      "Set this variable in production (OKT-60 auth_credential_env_var).",
  );
}

if (!scimAuthToken) {
  console.warn(
    "[acme-corp-q3] WARNING: SCIM_AUTH_TOKEN is not set. " +
      "All inbound SCIM requests will be accepted without authentication. " +
      "Set this variable in production — okta-dialect.md §9 requires auth " +
      "on every /Users/* and /Groups/* route.",
  );
}

const app = createAcmeCorpQ3Connector({
  targetBaseUrl,
  ...(targetApiToken !== undefined && { targetApiToken }),
  ...(scimAuthToken !== undefined && { scimAuthToken }),
});

const server = app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "acme-corp-q3 SCIM connector started",
      scim_base: `http://0.0.0.0:${PORT}/scim/v2`,
      target_base: targetBaseUrl,
      auth_configured: scimAuthToken !== undefined,
      target_auth_configured: targetApiToken !== undefined,
      ts: new Date().toISOString(),
    }),
  );
});

// Graceful shutdown — drain in-flight requests before closing.
process.on("SIGTERM", () => {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "SIGTERM received — shutting down gracefully",
      ts: new Date().toISOString(),
    }),
  );
  server.close(() => {
    console.log(
      JSON.stringify({
        level: "info",
        msg: "acme-corp-q3 SCIM connector stopped",
        ts: new Date().toISOString(),
      }),
    );
    process.exit(0);
  });
});