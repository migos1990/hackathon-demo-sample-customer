/**
 * Standalone entrypoint for the AcmeCorpQ3 SCIM connector.
 *
 * Reads env vars here — this is the ONLY file that touches process.env
 * (SECRETS-OUT law: env reading is isolated to the entrypoint; no other
 * connector file calls process.env directly).
 *
 * Required env vars for production:
 *   SCIM_AUTH_TOKEN           Bearer token Okta presents to this connector
 *   ACME_CORP_Q3_API_TOKEN    Bearer token this connector presents to AcmeCorpQ3 API
 *
 * Optional env vars:
 *   ACME_CORP_Q3_BASE_URL     Target API base URL (default: https://api.acme-corp-q3.example.com)
 *   CONNECTOR_PORT            Listen port (default: 3002)
 *
 * Dev mode: omit SCIM_AUTH_TOKEN and ACME_CORP_Q3_API_TOKEN — auth is
 * disabled on both sides (skeleton and client pass-through when tokens absent).
 * NEVER run prod without both tokens set.
 *
 * Startup validation: we check for required prod tokens and log a clear
 * warning (not a crash) so misconfigured deploys are easy to diagnose.
 * We do NOT crash on missing tokens because the OIN test harness spins up
 * the connector without tokens during its CI phase.
 */

import { createAcmeCorpQ3Connector } from "./server.js";

const PORT = parseInt(process.env["CONNECTOR_PORT"] ?? "3002", 10);
const TARGET_BASE_URL =
  process.env["ACME_CORP_Q3_BASE_URL"] ??
  "https://api.acme-corp-q3.example.com";
const SCIM_AUTH_TOKEN = process.env["SCIM_AUTH_TOKEN"];
const ACME_CORP_Q3_API_TOKEN = process.env["ACME_CORP_Q3_API_TOKEN"];

// ─── Startup warnings ─────────────────────────────────────────────────────────

if (!SCIM_AUTH_TOKEN) {
  console.warn(
    "[acme-corp-q3] WARNING: SCIM_AUTH_TOKEN is not set — " +
      "all incoming SCIM requests will be accepted without authentication. " +
      "This is safe ONLY in dev/test mode. Set this var before any production deploy.",
  );
}

if (!ACME_CORP_Q3_API_TOKEN) {
  console.warn(
    "[acme-corp-q3] WARNING: ACME_CORP_Q3_API_TOKEN is not set — " +
      "requests to AcmeCorpQ3 API will have no Authorization header. " +
      "This is safe ONLY if the AcmeCorpQ3 dev environment has auth disabled.",
  );
}

// ─── App creation + listen ────────────────────────────────────────────────────

const app = createAcmeCorpQ3Connector({
  targetBaseUrl: TARGET_BASE_URL,
  ...(ACME_CORP_Q3_API_TOKEN !== undefined && {
    targetApiToken: ACME_CORP_Q3_API_TOKEN,
  }),
  ...(SCIM_AUTH_TOKEN !== undefined && { scimAuthToken: SCIM_AUTH_TOKEN }),
});

app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      level: "info",
      message: "AcmeCorpQ3 SCIM connector started",
      connector: "acme-corp-q3",
      port: PORT,
      target_base_url: TARGET_BASE_URL,
      scim_base: `http://localhost:${PORT}/scim/v2`,
      auth_enabled: SCIM_AUTH_TOKEN !== undefined,
      target_auth_enabled: ACME_CORP_Q3_API_TOKEN !== undefined,
      okta_tenant: "demo-tomato-leopon-10388.oktapreview.com",
      ticket: "OKT-57",
    }),
  );
});