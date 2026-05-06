/**
 * Standalone entrypoint for the Acme HR System SCIM connector.
 *
 * Reads environment variables, validates required ones, calls
 * createAcmeHrSystemConnector, and starts the HTTP server.
 *
 * Environment variables (full list in RUNBOOK.md §1):
 *   SCIM_AUTH_TOKEN        — Bearer token Okta presents. Required in prod.
 *   ACME_HR_API_TOKEN      — Bearer token for Acme HR System API. Required in prod.
 *   ACME_HR_BASE_URL       — Target base URL. Defaults to prod URL.
 *   CONNECTOR_PORT         — Listen port. Defaults to 3003.
 *   NODE_ENV               — "production" enables strict env validation.
 *
 * Connector Law 4 SECRETS-OUT: no credentials in source. All from env.
 *
 * Usage:
 *   # dev (no auth enforced)
 *   npx tsx connectors/acme-hr-system/start.ts
 *
 *   # staging
 *   SCIM_AUTH_TOKEN=<token> ACME_HR_API_TOKEN=<token> \
 *   ACME_HR_BASE_URL=https://staging.acme-hr.example.com \
 *   npx tsx connectors/acme-hr-system/start.ts
 */
import { createAcmeHrSystemConnector } from "./server.js";

const DEFAULT_TARGET_URL = "https://api.acme-hr.example.com";
const DEFAULT_PORT = 3003;

function readEnv(): {
  targetBaseUrl: string;
  targetApiToken: string | undefined;
  scimAuthToken: string | undefined;
  port: number;
} {
  const targetBaseUrl =
    process.env["ACME_HR_BASE_URL"] ?? DEFAULT_TARGET_URL;

  const targetApiToken =
    process.env["ACME_HR_API_TOKEN"] !== ""
      ? process.env["ACME_HR_API_TOKEN"]
      : undefined;

  const scimAuthToken =
    process.env["SCIM_AUTH_TOKEN"] !== ""
      ? process.env["SCIM_AUTH_TOKEN"]
      : undefined;

  const rawPort = process.env["CONNECTOR_PORT"];
  const port = rawPort
    ? (Number.parseInt(rawPort, 10) || DEFAULT_PORT)
    : DEFAULT_PORT;

  // Strict validation in production — fail fast rather than run insecurely.
  if (process.env["NODE_ENV"] === "production") {
    const missing: string[] = [];
    if (!scimAuthToken) missing.push("SCIM_AUTH_TOKEN");
    if (!targetApiToken) missing.push("ACME_HR_API_TOKEN");
    if (missing.length > 0) {
      console.error(
        `[acme-hr-system] FATAL: missing required env vars in production: ${missing.join(", ")}`,
      );
      process.exit(1);
    }
  } else {
    // Warn in dev/staging so operators notice before promoting.
    if (!scimAuthToken) {
      console.warn(
        "[acme-hr-system] WARNING: SCIM_AUTH_TOKEN not set — auth disabled (dev mode). Do NOT use in production.",
      );
    }
    if (!targetApiToken) {
      console.warn(
        "[acme-hr-system] WARNING: ACME_HR_API_TOKEN not set — target API requests sent without auth.",
      );
    }
  }

  return { targetBaseUrl, targetApiToken, scimAuthToken, port };
}

function main(): void {
  const { targetBaseUrl, targetApiToken, scimAuthToken, port } = readEnv();

  const app = createAcmeHrSystemConnector({
    targetBaseUrl,
    targetApiToken,
    scimAuthToken,
  });

  app.listen(port, () => {
    console.log(
      JSON.stringify({
        level: "info",
        event: "connector_started",
        connector: "acme-hr-system",
        scim_base: `http://localhost:${port}/scim/v2`,
        target_base_url: targetBaseUrl,
        auth_enabled: scimAuthToken !== undefined,
        target_auth_enabled: targetApiToken !== undefined,
        okta_tenant: "demo-tomato-leopon-10388.oktapreview.com",
        terraform_workspace: "staging",
        ts: new Date().toISOString(),
      }),
    );
  });
}

main();