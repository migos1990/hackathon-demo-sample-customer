/**
 * Standalone entrypoint for the Acme HR System SCIM Connector.
 *
 * Run via:
 *   tsx connectors/acme-hr-system/start.ts
 *   # or, once built:
 *   node dist/connectors/acme-hr-system/start.js
 *
 * Environment variables (all documented in RUNBOOK.md):
 *   SCIM_AUTH_TOKEN          — bearer token Okta presents to this connector
 *   ACME_HR_API_TOKEN        — bearer token this connector presents to Acme HR API
 *   ACME_HR_SYSTEM_BASE_URL  — Acme HR API base URL (default: prod URL)
 *   CONNECTOR_PORT           — listen port (default: 3002)
 *
 * Ticket: OKT-10
 */
import { createAcmeHrSystemConnector } from "./server.js";

const PORT = parseInt(process.env["CONNECTOR_PORT"] ?? "3002", 10);

const app = createAcmeHrSystemConnector();

app.listen(PORT, () => {
  // Structured log line — correlates with request-id middleware logs.
  // Per Connector Law 8 OBSERVABLE.
  process.stdout.write(
    JSON.stringify({
      level: "info",
      msg: "Acme HR System SCIM connector listening",
      url: `http://localhost:${PORT}/scim/v2`,
      target_base_url:
        process.env["ACME_HR_SYSTEM_BASE_URL"] ??
        "https://api.acme-hr.example.com",
      auth_configured:
        process.env["SCIM_AUTH_TOKEN"] !== undefined &&
        process.env["SCIM_AUTH_TOKEN"] !== "",
      ticket: "OKT-10",
    }) + "\n",
  );
});