/**
 * /healthz — liveness + target reachability probe.
 *
 * Closes Connector Law 8 (OBSERVABLE) with logger.ts + request-id.ts.
 * Auth-exempt by design: health endpoints MUST be reachable without
 * credentials so upstream load balancers, k8s liveness probes, and
 * uptime pings can work.
 *
 * Response shape when the store has no ping method:
 *   { status: "ok", uptime_seconds: N, version: "..." }
 *
 * Response shape when the store's ping resolves:
 *   { status: "ok", uptime_seconds: N, version: "...", target_reachable: true }
 *
 * Response shape when the store's ping rejects (503 status):
 *   { status: "degraded", uptime_seconds: N, version: "...",
 *     target_reachable: false, target_error: "..." }
 *
 * Target reachability is OPTIONAL — the UserStore interface doesn't
 * require it. Generated connectors that wrap a remote API SHOULD expose
 * a cheap `ping()` that resolves on 2xx from a reachable target.
 */
import { Router, type Request, type Response } from "express";
import type { UserStore } from "../store/user-store.js";

const PROCESS_START_MS = Date.now();

/**
 * UserStore optionally exposes a cheap ping() that resolves on 2xx from
 * the backing target, rejects otherwise. We duck-type rather than widen
 * the UserStore interface (not every store HAS a remote target — the
 * in-memory reference implementation has nothing to ping).
 */
interface PingableStore {
  ping(): Promise<void>;
}

function hasPing(store: UserStore): store is UserStore & PingableStore {
  return typeof (store as unknown as { ping?: unknown }).ping === "function";
}

export function healthzRouter(store: UserStore): Router {
  const router = Router();

  router.get("/healthz", async (_req: Request, res: Response) => {
    const uptime_seconds = Math.floor((Date.now() - PROCESS_START_MS) / 1000);
    const version = process.env.CONNECTOR_VERSION ?? "dev";

    if (!hasPing(store)) {
      return res.status(200).json({ status: "ok", uptime_seconds, version });
    }

    try {
      await store.ping();
      return res.status(200).json({ status: "ok", uptime_seconds, version, target_reachable: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(503).json({
        status: "degraded",
        uptime_seconds,
        version,
        target_reachable: false,
        target_error: message,
      });
    }
  });

  return router;
}
