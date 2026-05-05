/**
 * RFC 7644 §3.12 Error envelope builder.
 *
 * Every 4xx/5xx response from our routes uses this shape. Okta's client
 * parses `scimType` to decide retry/surface-in-UI per okta-dialect.md §8.
 *
 * scimType must be one of RFC 7644 §3.12 values when set:
 *   invalidFilter, tooMany, uniqueness, mutability, invalidSyntax,
 *   invalidPath, noTarget, invalidValue, invalidVers, sensitive
 * Omit scimType for generic 500s.
 */

export type ScimTypeCode =
  | "invalidFilter"
  | "tooMany"
  | "uniqueness"
  | "mutability"
  | "invalidSyntax"
  | "invalidPath"
  | "noTarget"
  | "invalidValue"
  | "invalidVers"
  | "sensitive";

export interface ScimErrorEnvelope {
  schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"];
  status: string;
  scimType?: ScimTypeCode;
  detail: string;
}

/**
 * Build a SCIM error envelope. Status is coerced to string per RFC 7644.
 * The `detail` field is returned to callers including Okta; never include
 * PII or internal stack traces in it (per okta-dialect.md §11.6 guidance).
 */
export function scimError(status: number, detail: string, scimType?: ScimTypeCode): ScimErrorEnvelope {
  const envelope: ScimErrorEnvelope = {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    detail,
  };
  if (scimType !== undefined) {
    envelope.scimType = scimType;
  }
  return envelope;
}
