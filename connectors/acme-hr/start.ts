/**
 * Standalone entry point for the AcmeHR SCIM connector.
 *
 * Run the full demo stack locally:
 *   Terminal 1: npm run start:acme-hr           → AcmeHR-lite on :4001
 *   Terminal 2: npm run start:acme-hr-connector → SCIM connector on :3002
 *
 * Then point Okta (or curl) at http://localhost:3002/scim/v2/Users.
 */
import { createAcmeHrConnector } from "./server.js";

const PORT = Number.parseInt(process.env.CONNECTOR_PORT ?? "3002", 10);
const targetBaseUrl = process.env.ACME_HR_BASE_URL ?? "http://localhost:4001";
const targetApiToken = process.env.ACME_HR_API_TOKEN;
const scimAuthToken = process.env.SCIM_AUTH_TOKEN;

const app = createAcmeHrConnector({
  targetBaseUrl,
  ...(targetApiToken !== undefined && targetApiToken !== "" && { targetApiToken }),
  ...(scimAuthToken !== undefined && scimAuthToken !== "" && { scimAuthToken }),
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[acme-hr-connector] SCIM server on http://localhost:${PORT}/scim/v2`);
  // eslint-disable-next-line no-console
  console.log(`[acme-hr-connector] AcmeHR target:  ${targetBaseUrl}`);
  // eslint-disable-next-line no-console
  console.log(
    `[acme-hr-connector] auth: SCIM=${scimAuthToken ? "enabled" : "dev"}, target=${targetApiToken ? "enabled" : "dev"}`,
  );
});
