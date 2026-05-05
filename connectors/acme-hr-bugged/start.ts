#!/usr/bin/env node
/**
 * Standalone entry point for the DELIBERATELY BUGGED AcmeHR connector.
 *
 * Used only during the gate-refusal demo beat. The harness's verify
 * gates refuse this connector's output — that refusal IS the demo.
 *
 *   Terminal 1: npm run start:acme-hr                    → target
 *   Terminal 2: npm run start:acme-hr-connector-bugged   → bugged SCIM (:3003)
 *   Terminal 3: npm run smoke:bugged                     → fails at step 3
 *
 * Different default port (3003) so you can run the correct AND bugged
 * connectors side-by-side for an A/B moment.
 */
import { createBuggedAcmeHrConnector } from "./server.js";

const PORT = Number.parseInt(process.env.CONNECTOR_BUGGED_PORT ?? "3003", 10);
const targetBaseUrl = process.env.ACME_HR_BASE_URL ?? "http://localhost:4001";
const targetApiToken = process.env.ACME_HR_API_TOKEN;
const scimAuthToken = process.env.SCIM_AUTH_TOKEN;

const app = createBuggedAcmeHrConnector({
  targetBaseUrl,
  ...(targetApiToken !== undefined && targetApiToken !== "" && { targetApiToken }),
  ...(scimAuthToken !== undefined && scimAuthToken !== "" && { scimAuthToken }),
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[acme-hr-connector-BUGGED] on http://localhost:${PORT}/scim/v2 (DELIBERATELY BROKEN)`);
  // eslint-disable-next-line no-console
  console.log(`[acme-hr-connector-BUGGED] AcmeHR target: ${targetBaseUrl}`);
  // eslint-disable-next-line no-console
  console.log(`[acme-hr-connector-BUGGED] Bug: PATCH active:false is silently dropped. Gate-refusal demo only.`);
});
