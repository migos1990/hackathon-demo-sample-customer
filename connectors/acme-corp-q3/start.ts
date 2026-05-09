/**
 * Standalone entrypoint for the Acme Corp Q3 SCIM Connector.
 *
 * Usage:
 *   npx tsx connectors/acme-corp-q3/start.ts
 *   # or via package.json script:
 *   npm run start:acme-corp-q3-connector
 *
 * Required environment variables (production):
 *   SCIM_AUTH_TOKEN          — Bearer token Okta presents to this connector
 *   ACME_CORP_Q3_API_TOKEN   — Bearer token this connector presents to the HR API
 *
 * Optional environment variables:
 *   ACME_CORP_Q3_BASE_URL    — HR API base URL (default: https://api.acme-corp-q3.example.com)
 *   CONNECTOR_PORT           — Listen port (default: 3003)
 *
 * Law 4 SECRETS-OUT: all credentials via env vars. No defaults for secrets.
 * okta-dialect.md §9: auth middleware rejects requests without a valid
 * bearer token when SCIM_AUTH_TOKEN is set (OIN test suite step 20).
 */
import { createAcmeCorpQ3Connector } from "./server.js";

const PORT = parseInt(process.env["CONNECTOR_PORT"] ?? "3003", 10);

// Warn loudly in production if auth tokens are missing.
// Dev mode deliberately allows missing tokens for local iteration.
const scimAuthToken = process.env["SCIM_AUTH_TOKEN"];
const hrApiToken = process.env["ACME_CORP_Q3_API_TOKEN"];

if (!scimAuthToken) {
  console.warn(
    "[acme-corp-q3] WARNING: SCIM_AUTH_TOKEN is not set. " +
      "All SCIM requests will be accepted without authentication. " +
      "This is only safe in local dev. Set this before connecting to Okta.",
  );
}

if (!hrApiToken) {
  console.warn(
    "[acme-corp-q3] WARNING: ACME_CORP_Q3_API_TOKEN is not set. " +
      "Requests to the HR API will be sent without credentials. " +
      "This will fail unless the HR API is also in dev/no-auth mode.",
  );
}

const app = createAcmeCorpQ3Connector();

app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "Acme Corp Q3 SCIM connector listening",
      base_url: `http://localhost:${PORT}/scim/v2`,
      scim_auth_configured: scimAuthToken !== undefined,
      hr_api_auth_configured: hrApiToken !== undefined,
      hr_api_base_url:
        process.env["ACME_CORP_Q3_BASE_URL"] ??
        "https://api.acme-corp-q3.example.com",
      target_okta_tenant: "demo-tomato-leopon-10388.oktapreview.com",
    }),
  );
});