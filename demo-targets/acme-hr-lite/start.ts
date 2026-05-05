/**
 * Standalone entry point for AcmeHR-lite.
 *
 * Run: `npm run start:acme-hr` → http://localhost:4001/admin
 *
 * For demo day: seed the tenant via the generated SCIM connector, watch
 * users populate on /admin in real time.
 */
import { createAcmeHrApp } from "./server.js";

const PORT = Number.parseInt(process.env.ACME_HR_PORT ?? "4001", 10);
const apiTokenEnv = process.env.ACME_HR_API_TOKEN;

const app = createAcmeHrApp({
  ...(apiTokenEnv !== undefined && apiTokenEnv !== "" && { apiToken: apiTokenEnv }),
});

app.listen(PORT, () => {
  const authStatus = apiTokenEnv ? "bearer auth ENABLED" : "dev mode (no auth)";
  // eslint-disable-next-line no-console
  console.log(`[acme-hr-lite] listening on http://localhost:${PORT}  (${authStatus})`);
  // eslint-disable-next-line no-console
  console.log(`[acme-hr-lite] admin UI: http://localhost:${PORT}/admin`);
});
