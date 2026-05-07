/**
 * Standalone entrypoint for the Acme HR System SCIM connector.
 *
 * ticket: OKT-10
 * customer: Acme HR System
 * slug: acme-hr-system
 *
 * Run via:
 *   npx tsx connectors/acme-hr-system/start.ts
 * or (once wired in package.json):
 *   npm run start:acme-hr-system-connector
 *
 * Environment variables (see RUNBOOK.md for full reference):
 *   SCIM_AUTH_TOKEN        — Bearer token Okta presents to this connector.
 *                            Required in staging/prod. Omit for dev-mode.
 *   ACME_HR_API_TOKEN      — Bearer token this connector presents to AcmeHR.
 *                            Required in staging/prod. Omit for dev-mode.
 *   ACME_HR_BASE_URL       — Base URL of the Acme HR System API.
 *                            Defaults to https://api.acme-hr.example.com (prod).
 *   CONNECTOR_PORT         — Listen port. Defaults to 3003.
 *
 * Per okta-dialect.md §9: MISSING SCIM_AUTH_TOKEN in prod means every Okta
 * request passes authentication — this is a security hole. The startup log
 * warns loudly when the token is absent.
 */
import { createAcmeHrSystemConnector } from "./server.js";

const PORT = parseInt(process.env.CONNECTOR_PORT ?? "3003", 10);
const BASE_URL =
  process.env.ACME_HR_BASE_URL ?? "https://api.acme-hr.example.com";
const API_TOKEN = process.env.ACME_HR_API_TOKEN;
const SCIM_TOKEN = process.env.SCIM_AUTH_TOKEN;

// Loud warning when running without auth tokens — prevents silent
// misconfiguration in staging/prod. Per okta-dialect.md §9.
if (!SCIM_TOKEN) {
  console.warn(
    "[acme-hr-system] WARNING: SCIM_AUTH_TOKEN is not set. " +
      "All incoming requests will bypass authentication. " +
      "This is ONLY acceptable in local dev. Set the token before deploying.",
  );
}
if (!API_TOKEN) {
  console.warn(
    "[acme-hr-system] WARNING: ACME_HR_API_TOKEN is not set. " +
      "Requests to the Acme HR System API will be unauthenticated. " +
      "This is ONLY acceptable if the target has no auth requirement in dev.",
  );
}

const app = createAcmeHrSystemConnector({
  targetBaseUrl: BASE_URL,
  ...(API_TOKEN !== undefined && { targetApiToken: API_TOKEN }),
  ...(SCIM_TOKEN !== undefined && { scimAuthToken: SCIM_TOKEN }),
});

app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "Acme HR System SCIM connector listening",
      port: PORT,
      target_base_url: BASE_URL,
      scim_base: `http://localhost:${PORT}/scim/v2`,
      auth_enabled: Boolean(SCIM_TOKEN),
      target_auth_enabled: Boolean(API_TOKEN),
      ticket: "OKT-10",
      slug: "acme-hr-system",
    }),
  );
});