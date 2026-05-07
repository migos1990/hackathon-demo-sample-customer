/**
 * Standalone entrypoint for the Acme HR System SCIM Connector.
 *
 * Reads environment variables, constructs the connector app via
 * createAcmeHrSystemConnector, and starts listening.
 *
 * Environment variables (all documented in RUNBOOK.md §Environment variables):
 *
 *   SCIM_AUTH_TOKEN          — bearer token Okta presents to this connector
 *   ACME_HR_API_TOKEN        — bearer token this connector presents to the target
 *   ACME_HR_BASE_URL         — target API base URL (defaults to prod)
 *   CONNECTOR_PORT           — listen port (defaults to 3002)
 *   NODE_ENV                 — "production" | "staging" | "development"
 *
 * Startup warnings:
 *   - Missing SCIM_AUTH_TOKEN in non-dev → logged as WARN (connector still
 *     starts, but every Okta request will be unauthenticated). Do NOT ship
 *     to prod without this set. okta-dialect.md §9.
 *   - Missing ACME_HR_API_TOKEN → WARN. Target calls will proceed
 *     unauthenticated (target may reject them).
 *
 * Signal handling:
 *   SIGTERM / SIGINT → graceful close (in-flight requests drain; new
 *   connections refused). Node's http.Server.close() handles this.
 *   Good-citizen behaviour for containerised deployments (Kubernetes
 *   sends SIGTERM before SIGKILL).
 */
import { createAcmeHrSystemConnector } from "./server.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const NODE_ENV = process.env["NODE_ENV"] ?? "development";
const isDev = NODE_ENV === "development";

const SCIM_AUTH_TOKEN = process.env["SCIM_AUTH_TOKEN"];
const ACME_HR_API_TOKEN = process.env["ACME_HR_API_TOKEN"];
const ACME_HR_BASE_URL = process.env["ACME_HR_BASE_URL"];
const PORT = parseInt(process.env["CONNECTOR_PORT"] ?? "3002", 10);

// ─── Startup warnings ────────────────────────────────────────────────────────

if (!SCIM_AUTH_TOKEN && !isDev) {
  console.warn(
    "[acme-hr-system] WARN: SCIM_AUTH_TOKEN is not set. " +
      "Okta requests will not be authenticated. " +
      "Set SCIM_AUTH_TOKEN before connecting Okta. " +
      "(okta-dialect.md §9 — OIN test step 20 requires 401 on missing auth)",
  );
}

if (!ACME_HR_API_TOKEN && !isDev) {
  console.warn(
    "[acme-hr-system] WARN: ACME_HR_API_TOKEN is not set. " +
      "Requests to the Acme HR System API will be unauthenticated.",
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

const app = createAcmeHrSystemConnector({
  ...(ACME_HR_BASE_URL !== undefined && { targetBaseUrl: ACME_HR_BASE_URL }),
  ...(ACME_HR_API_TOKEN !== undefined && { targetApiToken: ACME_HR_API_TOKEN }),
  ...(SCIM_AUTH_TOKEN !== undefined && { scimAuthToken: SCIM_AUTH_TOKEN }),
});

// ─── Listen ──────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "Acme HR System SCIM connector started",
      connector: "acme-hr-system",
      scim_base: `http://0.0.0.0:${PORT}/scim/v2`,
      target_base: ACME_HR_BASE_URL ?? "https://api.acme-hr.example.com (default)",
      environment: NODE_ENV,
      auth_configured: Boolean(SCIM_AUTH_TOKEN),
    }),
  );
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────

function shutdown(signal: string): void {
  console.log(
    JSON.stringify({
      level: "info",
      msg: `${signal} received — shutting down gracefully`,
      connector: "acme-hr-system",
    }),
  );
  server.close((err) => {
    if (err) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "Error during graceful shutdown",
          error: String(err),
        }),
      );
      process.exit(1);
    }
    console.log(
      JSON.stringify({ level: "info", msg: "Server closed", connector: "acme-hr-system" }),
    );
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));