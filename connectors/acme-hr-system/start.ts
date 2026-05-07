/**
 * Standalone entrypoint for the Acme HR System SCIM Connector.
 *
 * Run via:
 *   npm run start:acme-hr-system-connector
 * or directly:
 *   node --import tsx/esm connectors/acme-hr-system/start.ts
 *
 * Environment variables (see RUNBOOK.md for full reference):
 *   SCIM_AUTH_TOKEN       Bearer token Okta presents to this connector.
 *   ACME_HR_API_TOKEN     Bearer token this connector presents to the target.
 *   ACME_HR_BASE_URL      Target API base URL (defaults to prod endpoint).
 *   CONNECTOR_PORT        Listen port (defaults to 3003).
 *
 * Law 4 SECRETS-OUT: no tokens are hard-coded. Missing tokens in production
 * result in auth middleware being a no-op (dev-mode). The RUNBOOK.md
 * documents this and requires both tokens to be set before prod deployment.
 */
import { createAcmeHrSystemConnector } from "./server.js";

const TARGET_BASE_URL =
  process.env["ACME_HR_BASE_URL"] ?? "https://api.acme-hr.example.com";
const TARGET_API_TOKEN = process.env["ACME_HR_API_TOKEN"];
const SCIM_AUTH_TOKEN = process.env["SCIM_AUTH_TOKEN"];
const PORT = Number(process.env["CONNECTOR_PORT"] ?? "3003");

const app = createAcmeHrSystemConnector({
  targetBaseUrl: TARGET_BASE_URL,
  ...(TARGET_API_TOKEN !== undefined && { targetApiToken: TARGET_API_TOKEN }),
  ...(SCIM_AUTH_TOKEN !== undefined && { scimAuthToken: SCIM_AUTH_TOKEN }),
});

app.listen(PORT, () => {
  const envLabel =
    TARGET_BASE_URL.includes("dev.")
      ? "dev"
      : TARGET_BASE_URL.includes("staging.")
        ? "staging"
        : "prod";

  console.log(
    JSON.stringify({
      level: "info",
      msg: "Acme HR System SCIM connector listening",
      url: `http://localhost:${PORT}/scim/v2`,
      target: TARGET_BASE_URL,
      env: envLabel,
      auth_configured: SCIM_AUTH_TOKEN !== undefined,
      target_auth_configured: TARGET_API_TOKEN !== undefined,
      ts: new Date().toISOString(),
    }),
  );

  if (SCIM_AUTH_TOKEN === undefined) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "SCIM_AUTH_TOKEN is not set — connector will accept any bearer token (DEV MODE ONLY)",
        ts: new Date().toISOString(),
      }),
    );
  }

  if (TARGET_API_TOKEN === undefined) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "ACME_HR_API_TOKEN is not set — requests to target will have no auth (DEV MODE ONLY)",
        ts: new Date().toISOString(),
      }),
    );
  }
});