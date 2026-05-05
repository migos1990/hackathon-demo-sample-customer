/**
 * SCIM compliance validator — Day-8 post-deploy check.
 *
 * Introspects a running connector's /ServiceProviderConfig and asserts
 * it advertises what the ticket template's `required_ops` block asked
 * for. Catches the silent-feature-regression failure mode where a
 * connector claims to support PATCH / filter but tells Okta at metadata
 * time that it doesn't — Okta honors the metadata claim, so the OIN
 * SPEC Tests never exercise the feature and the bug ships.
 *
 * Feeds the promotion pipeline: violations from this validator become
 * a gate refusal at manifest-build time (extend preprod_verify.scim_
 * compliance_passed on the next schema bump).
 */

export interface RequiredOps {
  users_create: boolean;
  users_read: boolean;
  users_update_patch: boolean;
  users_list: boolean;
  users_filter: boolean;
  users_delete: boolean;
  groups: boolean;
  group_push: boolean;
  group_members_patch: boolean;
}

export interface ScimComplianceOptions {
  connectorUrl: string;
  requiredOps: RequiredOps;
  /** Override for tests; defaults to ambient global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ComplianceViolation {
  check: string;
  detail: string;
}

export interface ScimComplianceResult {
  ok: boolean;
  violations: ComplianceViolation[];
}

export async function validateScimCompliance(
  opts: ScimComplianceOptions,
): Promise<ScimComplianceResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.connectorUrl.replace(/\/+$/, "");
  const violations: ComplianceViolation[] = [];

  let res: Response;
  try {
    res = await fetchImpl(`${base}/scim/v2/ServiceProviderConfig`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      violations: [{
        check: "serviceproviderconfig.reachable",
        detail: `failed to fetch /scim/v2/ServiceProviderConfig: ${msg}`,
      }],
    };
  }

  if (!res.ok) {
    violations.push({
      check: "serviceproviderconfig.reachable",
      detail: `got HTTP ${res.status} from /scim/v2/ServiceProviderConfig`,
    });
    return { ok: false, violations };
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("scim+json") && !contentType.includes("application/json")) {
    violations.push({
      check: "serviceproviderconfig.content_type",
      detail: `expected scim+json or application/json, got ${contentType}`,
    });
  }

  let spc: ServiceProviderConfigShape;
  try {
    spc = (await res.json()) as ServiceProviderConfigShape;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      violations: [...violations, {
        check: "serviceproviderconfig.parseable",
        detail: `failed to parse body as JSON: ${msg}`,
      }],
    };
  }

  // PATCH capability check
  if (opts.requiredOps.users_update_patch && spc.patch?.supported !== true) {
    violations.push({
      check: "patch.supported",
      detail: `ticket requires users_update_patch=true but /ServiceProviderConfig advertises patch.supported=${String(spc.patch?.supported)}`,
    });
  }

  // Filter capability check
  if (opts.requiredOps.users_filter && spc.filter?.supported !== true) {
    violations.push({
      check: "filter.supported",
      detail: `ticket requires users_filter=true but /ServiceProviderConfig advertises filter.supported=${String(spc.filter?.supported)}`,
    });
  }

  return { ok: violations.length === 0, violations };
}

interface ServiceProviderConfigShape {
  schemas?: string[];
  patch?: { supported?: boolean };
  filter?: { supported?: boolean; maxResults?: number };
  bulk?: { supported?: boolean };
  changePassword?: { supported?: boolean };
  sort?: { supported?: boolean };
  etag?: { supported?: boolean };
  authenticationSchemes?: unknown[];
}
