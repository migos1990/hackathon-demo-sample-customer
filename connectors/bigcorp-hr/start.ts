/**
 * BigCorpHR SCIM Connector — standalone startup.
 *
 * Environment variables (see RUNBOOK.md for full table):
 *   SCIM_AUTH_TOKEN        — bearer token Okta presents to this connector
 *   BIGCORP_HR_API_TOKEN   — bearer token this connector presents to BigCorpHR
 *   BIGCORP_HR_BASE_URL    — BigCorpHR API base URL (defaults to prod)
 *   CONNECTOR_PORT         — listen port (default 3002)
 *
 * In dev, omit SCIM_AUTH_TOKEN and BIGCORP_HR_API_TOKEN — both layers
 * pass-through when tokens are absent.  NEVER ship without both set in prod.
 */
import { createBigCorpHrConnector } from "./server.js";

const port = Number(process.env["CONNECTOR_PORT"] ?? 3002);

const targetBaseUrl =
  process.env["BIGCORP_HR_BASE_URL"] ?? "https://api.bigcorp-hr.example.com";

const app = createBigCorpHrConnector({
  targetBaseUrl,
  ...(process.env["BIGCORP_HR_API_TOKEN"] !== undefined && {
    targetApiToken: process.env["BIGCORP_HR_API_TOKEN"],
  }),
  ...(process.env["SCIM_AUTH_TOKEN"] !== undefined && {
    scimAuthToken: process.env["SCIM_AUTH_TOKEN"],
  }),
});

app.listen(port, () => {
  // Structured log line — Connector Law 8 OBSERVABLE.
  console.log(
    JSON.stringify({
      level: "info",
      msg: "BigCorpHR SCIM connector listening",
      url: `http://localhost:${port}/scim/v2`,
      target: targetBaseUrl,
      auth_configured: Boolean(process.env["SCIM_AUTH_TOKEN"]),
    }),
  );
});