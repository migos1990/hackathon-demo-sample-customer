/**
 * Standalone entrypoint — BigCorpHR SCIM Connector.
 *
 * Usage:
 *   npx tsx connectors/bigcorp-hr/start.ts
 *   # or, once compiled:
 *   node dist/connectors/bigcorp-hr/start.js
 *
 * Environment variables (all documented in RUNBOOK.md):
 *   SCIM_AUTH_TOKEN           — Bearer token Okta must present (required in prod)
 *   BIGCORP_HR_API_TOKEN      — Bearer token for BigCorpHR API (required in prod)
 *   BIGCORP_HR_BASE_URL       — BigCorpHR API base URL (defaults to ticket value)
 *   CONNECTOR_PORT            — Listen port (default: 3003)
 *
 * Missing SCIM_AUTH_TOKEN or BIGCORP_HR_API_TOKEN in prod is a security
 * incident waiting to happen. This file logs a prominent WARNING when either
 * is absent, and exits non-zero in NODE_ENV=production without them.
 *
 * Per Connector Law 4 (SECRETS-OUT): no tokens are hard-coded here or
 * anywhere in the connector source. All credentials come from environment
 * variables.
 */

import { createBigCorpHrConnector } from "./server.js";

const DEFAULT_PORT = 3003;
const DEFAULT_BASE_URL = "https://api.bigcorp-hr.example.com";

function requireEnvInProd(name: string, value: string | undefined): void {
  if (!value && process.env["NODE_ENV"] === "production") {
    console.error(
      `[bigcorp-hr] FATAL: ${name} is required in production. Exiting.`,
    );
    process.exit(1);
  }
  if (!value) {
    console.warn(
      `[bigcorp-hr] WARNING: ${name} is not set — running in dev/no-auth mode. ` +
        `Never deploy to production without this variable.`,
    );
  }
}

const scimAuthToken = process.env["SCIM_AUTH_TOKEN"];
const bigCorpHrApiToken = process.env["BIGCORP_HR_API_TOKEN"];
const baseUrl = process.env["BIGCORP_HR_BASE_URL"] ?? DEFAULT_BASE_URL;
const port = Number.parseInt(process.env["CONNECTOR_PORT"] ?? String(DEFAULT_PORT), 10);

requireEnvInProd("SCIM_AUTH_TOKEN", scimAuthToken);
requireEnvInProd("BIGCORP_HR_API_TOKEN", bigCorpHrApiToken);

const app = createBigCorpHrConnector({
  targetBaseUrl: baseUrl,
  ...(bigCorpHrApiToken !== undefined && { targetApiToken: bigCorpHrApiToken }),
  ...(scimAuthToken !== undefined && { scimAuthToken }),
});

const server = app.listen(port, () => {
  console.log(
    JSON.stringify({
      level: "info",
      event: "connector_started",
      connector: "bigcorp-hr",
      port,
      target_base_url: baseUrl,
      scim_base: `http://localhost:${port}/scim/v2`,
      auth_mode: scimAuthToken ? "bearer" : "DISABLED (dev)",
      target_auth_mode: bigCorpHrApiToken ? "bearer" : "DISABLED (dev)",
      timestamp: new Date().toISOString(),
    }),
  );
});

// Graceful shutdown — prevents in-flight SCIM requests from being cut off
// mid-flight during a rolling deploy or SIGTERM from the container runtime.
function shutdown(signal: string): void {
  console.log(
    JSON.stringify({
      level: "info",
      event: "connector_shutdown",
      connector: "bigcorp-hr",
      signal,
      timestamp: new Date().toISOString(),
    }),
  );
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));