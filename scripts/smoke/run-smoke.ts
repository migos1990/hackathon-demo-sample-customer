/**
 * Smoke runner — post-deploy end-to-end lifecycle check for a generated
 * SCIM connector + its target app.
 *
 * Closes Connector Law 6 (SMOKE-GREEN) per docs/connector-laws.md. The
 * return shape (smoke_test_passed, log_errors_count) is compatible with
 * the fields in PreprodVerify at scripts/promotion-manifest/types.ts, so
 * this runner's output feeds directly into buildManifest.
 *
 * Three steps, in order:
 *   1. SCIM POST a synthetic user to the connector. Verify 201 + body shape.
 *   2. SCIM PATCH active:false on that user. Verify 200 + active=false.
 *   3. Read directly from the target app's API to confirm enabled=false
 *      actually landed. This step is what catches connector lies (the
 *      connector returning the "right" response but not actually mutating
 *      the target).
 *
 * log_errors_count is incremented per step failure. Any non-zero count
 * is a gate-blocking signal per scripts/promotion-manifest/build.ts.
 */
import { randomBytes } from "node:crypto";

export interface SmokeOptions {
  /** Base URL of the connector that speaks SCIM to Okta (e.g. http://localhost:3002). */
  connectorUrl: string;
  /** Base URL of the target app's native API (e.g. http://localhost:4001). */
  targetUrl: string;
  /** Optional bearer token for the connector's SCIM surface. */
  connectorAuthToken?: string;
  /** Optional bearer token for the target app's API. */
  targetAuthToken?: string;
  /** Override for tests; defaults to ambient global fetch. */
  fetchImpl?: typeof fetch;
}

export interface SmokeStep {
  name: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface SmokeReport {
  ran_at: string;
  smoke_test_passed: boolean;
  log_errors_count: number;
  steps: SmokeStep[];
}

export async function runSmoke(opts: SmokeOptions): Promise<SmokeReport> {
  const ran_at = new Date().toISOString();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const connectorBase = opts.connectorUrl.replace(/\/+$/, "");
  const targetBase = opts.targetUrl.replace(/\/+$/, "");

  // Per-run unique userName so repeat runs don't collide on uniqueness.
  const userName = `smoke-${randomBytes(6).toString("hex")}`;

  const steps: SmokeStep[] = [];
  let log_errors_count = 0;

  // Step 1: provision via SCIM.
  const provisionStep = await timed("scim-provision", async () => {
    const res = await fetchImpl(`${connectorBase}/scim/v2/Users`, {
      method: "POST",
      headers: scimHeaders(opts.connectorAuthToken),
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName,
        name: { givenName: "Smoke", familyName: "User", formatted: "Smoke User" },
        emails: [{ value: `${userName}@example.com`, primary: true, type: "work" }],
        active: true,
      }),
    });
    if (res.status !== 201) {
      throw new Error(`expected 201, got ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { userName?: string; active?: boolean };
    if (body.userName !== userName) {
      throw new Error(`userName mismatch: expected ${userName}, got ${body.userName}`);
    }
    if (body.active !== true) {
      throw new Error(`expected active=true after create, got ${String(body.active)}`);
    }
  });
  steps.push(provisionStep);
  if (!provisionStep.ok) log_errors_count++;

  // Step 2: deactivate via SCIM PATCH.
  const deactivateStep = await timed("scim-patch-deactivate", async () => {
    if (!provisionStep.ok) throw new Error("skipped: provision failed");
    const res = await fetchImpl(`${connectorBase}/scim/v2/Users/${encodeURIComponent(userName)}`, {
      method: "PATCH",
      headers: scimHeaders(opts.connectorAuthToken),
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", value: { active: false } }],
      }),
    });
    if (res.status !== 200) {
      throw new Error(`expected 200, got ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { active?: boolean };
    if (body.active !== false) {
      throw new Error(`expected active=false after PATCH, got ${String(body.active)}`);
    }
  });
  steps.push(deactivateStep);
  if (!deactivateStep.ok) log_errors_count++;

  // Step 3: verify by reading the TARGET directly. This is what catches the
  // case where the connector lied about applying the PATCH.
  const verifyStep = await timed("target-verify-deactivated", async () => {
    if (!deactivateStep.ok) throw new Error("skipped: deactivation step failed");
    const headers: Record<string, string> = {};
    if (opts.targetAuthToken !== undefined) {
      headers.authorization = `Bearer ${opts.targetAuthToken}`;
    }
    const res = await fetchImpl(`${targetBase}/users/${encodeURIComponent(userName)}`, {
      method: "GET",
      headers,
    });
    if (res.status !== 200) {
      throw new Error(`target GET expected 200, got ${res.status}`);
    }
    const body = (await res.json()) as { enabled?: boolean };
    if (body.enabled !== false) {
      throw new Error(
        `target reports enabled=${String(body.enabled)}; connector did not apply deactivation`,
      );
    }
  });
  steps.push(verifyStep);
  if (!verifyStep.ok) log_errors_count++;

  return {
    ran_at,
    smoke_test_passed: steps.every((s) => s.ok),
    log_errors_count,
    steps,
  };
}

async function timed(name: string, fn: () => Promise<void>): Promise<SmokeStep> {
  const start = Date.now();
  try {
    await fn();
    return { name, ok: true, durationMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, ok: false, durationMs: Date.now() - start, error: message };
  }
}

function scimHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/scim+json" };
  if (token !== undefined) h.authorization = `Bearer ${token}`;
  return h;
}
