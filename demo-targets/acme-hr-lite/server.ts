/**
 * AcmeHR-lite — Express app factory.
 *
 * Mock target app the generated SCIM connector provisions TO during the
 * demo (see docs/demo-script.md shot 5). Factory-per-app pattern so tests
 * spin up isolated instances — same convention as skeleton/server.ts.
 *
 * Listens on port 4001 by default (non-conflict with skeleton on 3000)
 * when run standalone.
 */
import express, { type Application } from "express";
import { InMemoryAcmeHrStore } from "./store.js";
import { usersRouter } from "./routes/users.js";
import { adminRouter } from "./routes/admin.js";
import { acmeHrAuth } from "./middleware/auth.js";

export interface CreateAcmeHrAppOptions {
  /** Injected store. Defaults to a fresh in-memory instance per call. */
  store?: InMemoryAcmeHrStore;
  /** Bearer token clients must present. Omit/empty = dev-mode (no auth). */
  apiToken?: string;
}

export function createAcmeHrApp(options: CreateAcmeHrAppOptions = {}): Application {
  const app = express();
  const store = options.store ?? new InMemoryAcmeHrStore();

  app.use(express.json({ limit: "512kb" }));

  // Admin page is mounted BEFORE the auth middleware so it is auth-exempt.
  // Rationale in routes/admin.ts header — read-only UI for the demo video.
  app.use("/admin", adminRouter(store));

  app.use(acmeHrAuth({ ...(options.apiToken !== undefined && { apiToken: options.apiToken }) }));

  app.use("/users", usersRouter(store));

  return app;
}
