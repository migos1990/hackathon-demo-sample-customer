/**
 * Metadata endpoints per RFC 7644 §4:
 *   - GET /ServiceProviderConfig — server capabilities
 *   - GET /Schemas — core User + Group schemas
 *   - GET /ResourceTypes — resource type definitions
 *
 * Per okta-dialect.md §10: these endpoints are queried by Okta on app
 * connection. patch.supported and filter.supported must be true or Okta
 * degrades / skips the app. Other supported-flags should be honest.
 *
 * Uses SCIMMY only for schema definitions, not for routing. See
 * docs/integrations/scimmy-subset.md for the subset-use rationale.
 */
import { Router, type Request, type Response } from "express";
import SCIMMY from "scimmy";

export const metaRouter = Router();

const SERVICE_PROVIDER_CONFIG = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  documentationUri: "https://github.com/louismigault/scim-harness/blob/main/docs/okta-dialect.md",
  patch: { supported: true }, // UNVERIFIED in the fixture suite yet; covered by skeleton's PATCH handler (forthcoming).
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      name: "OAuth Bearer Token",
      description: "Authentication scheme using the OAuth Bearer Token Standard",
      specUri: "https://www.rfc-editor.org/info/rfc6750",
      type: "oauthbearertoken",
      primary: true,
    },
  ],
  meta: {
    location: "/scim/v2/ServiceProviderConfig",
    resourceType: "ServiceProviderConfig",
  },
} as const;

metaRouter.get("/ServiceProviderConfig", (_req: Request, res: Response) => {
  res.status(200).json(SERVICE_PROVIDER_CONFIG);
});

metaRouter.get("/Schemas", (_req: Request, res: Response) => {
  const resources = [
    SCIMMY.Schemas.User.definition.describe(),
    SCIMMY.Schemas.Group.definition.describe(),
  ];
  res.status(200).json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  });
});

metaRouter.get("/ResourceTypes", (_req: Request, res: Response) => {
  const resources = [
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "User",
      name: "User",
      endpoint: "/Users",
      description: "User resource per RFC 7643 §4.1",
      schema: "urn:ietf:params:scim:schemas:core:2.0:User",
      meta: { location: "/scim/v2/ResourceTypes/User", resourceType: "ResourceType" },
    },
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "Group",
      name: "Group",
      endpoint: "/Groups",
      description: "Group resource per RFC 7643 §4.2",
      schema: "urn:ietf:params:scim:schemas:core:2.0:Group",
      meta: { location: "/scim/v2/ResourceTypes/Group", resourceType: "ResourceType" },
    },
  ];
  res.status(200).json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  });
});
