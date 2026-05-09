/**
 * Standalone startup for the AcmeCorpQ3 SCIM Connector.
 *
 * Run via:
 *   npm run start:acme-corp-q3-connector
 *   (or: tsx connectors/acme-corp-q3/start.ts)
 *
 * Environment variables (all documented in RUNBOOK.md):
 *   SCIM_AUTH_TOKEN         — bearer token Okta presents to this connector
 *   ACME_CORP_Q3_API_TOKEN  — bearer token this connector presents to AcmeCorpQ3
 *   ACME_CORP_Q3_BASE_URL   — override the native API base URL
 *   CONNECTOR_PORT          — listen port (default 3003)
 *
 * OIN citation: docs/okta-dialect.md §9 (auth), Connector Law 4 SECRETS-OUT,
 * Connector Law 8 OBSERVABLE.
 *
 * No real tokens in this file — all from env. Connector Law 4 SECRETS-OUT.
 */
import { createAcmeCorpQ3Connector } from "./server.js";

// ---------------------------------------------------------------------------
// Structured logger (console-JSON, no external dep for the harness)
// ---------------------------------------------------------------------------

const logger = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: "info", ts: new Date().toISOString(), msg, ...meta })),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: "warn", ts: new Date().toISOString(), msg, ...meta })),
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: "error", ts: new Date().toISOString(), msg, ...meta })),
};

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const scimAuthToken = process.env["SCIM_AUTH_TOKEN"];
const targetApiToken = process.env["ACME_CORP_Q3_API_TOKEN"];

// OKT-57: environments.dev = https://api.dev.acme-corp-q3.example.com
//         base_url          = https://api.acme-corp-q3.example.com
const targetBaseUrl =
  process.env["ACME_CORP_Q3_BASE_URL"] ??
  (process.env["NODE_ENV"] === "production"
    ? "https://api.acme-corp-q3.example.com"
    : "https://api.dev.acme-corp-q3.example.com");

const port = parseInt(process.env["CONNECTOR_PORT"] ?? "3003", 10);

// ---------------------------------------------------------------------------
// Warn on missing tokens (production guard)
// ---------------------------------------------------------------------------

if (!scimAuthToken) {
  logger.warn(
    "SCIM_AUTH_TOKEN is not set — connector is unauthenticated (dev mode only). " +
      "OIN step 20 will fail without this token in production.",
    { env: process.env["NODE_ENV"] ?? "development" },
  );
}

if (!targetApiToken) {
  logger.warn(
    "ACME_CORP_Q3_API_TOKEN is not set — requests to the native API will be " +
      "unauthenticated (dev mode only).",
    { env: process.env["NODE_ENV"] ?? "development" },
  );
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const app = createAcmeCorpQ3Connector({
  targetBaseUrl,
  ...(targetApiToken !== undefined && { targetApiToken }),
  ...(scimAuthToken !== undefined && { scimAuthToken }),
  logger,
});

app.listen(port, () => {
  logger.info("AcmeCorpQ3 SCIM connector listening", {
    url: `http://localhost:${port}/scim/v2`,
    target: targetBaseUrl,
    auth: scimAuthToken ? "bearer (configured)" : "none (dev mode)",
    lifecycle_policy: "soft_delete",
    ticket: "OKT-57",
  });
});