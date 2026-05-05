/**
 * /Users routes per RFC 7644 §3.4 and okta-dialect.md §1-§6.
 *
 * This cycle adds GET /Users/:id. Subsequent TDD cycles add LIST,
 * CREATE, PATCH. Per BLAST-RADIUS LAW the store is injected — no
 * module-level state.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { UserNameConflictError, type UserStore } from "../store/user-store.js";
import { scimError } from "../middleware/error-envelope.js";
import type { ScimUser } from "../types.js";

const CORE_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

/**
 * Maximum page size we will honor regardless of `count` query param.
 * Matches the filter.maxResults declared in ServiceProviderConfig (meta.ts).
 * Honesty per the GOLDEN LAW: don't advertise capacity we won't deliver.
 */
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 100; // per okta-dialect.md §7 (Okta protocol ref)

export function usersRouter(store: UserStore): Router {
  const router = Router();

  // LIST — GET /scim/v2/Users with optional ?filter, ?startIndex, ?count
  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const startIndex = parsePositiveInt(req.query["startIndex"], 1);
      const requestedCount = parsePositiveInt(req.query["count"], DEFAULT_PAGE_SIZE);
      const count = Math.min(requestedCount, MAX_PAGE_SIZE);
      const filter = typeof req.query["filter"] === "string" ? req.query["filter"] : undefined;

      let result;
      try {
        result = await store.list({ startIndex, count, ...(filter !== undefined && { filter }) });
      } catch (err) {
        // scim2-parse-filter throws on malformed filter. Map to 400 + invalidFilter
        // per RFC 7644 §3.12 and okta-dialect.md §8.
        return res.status(400).json(
          scimError(400, `Malformed filter: ${(err as Error).message}`, "invalidFilter"),
        );
      }

      return res.status(200).json({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        totalResults: result.total,
        startIndex,
        itemsPerPage: result.resources.length,
        Resources: result.resources,
      });
    } catch (err) {
      return next(err);
    }
  });

  // CREATE — POST /scim/v2/Users
  router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validation = validateUserBody(req.body);
      if (!validation.ok) {
        return res.status(400).json(scimError(400, validation.detail, validation.scimType));
      }

      try {
        const created = await store.create(validation.input);
        return res.status(201).json(created);
      } catch (err) {
        if (err instanceof UserNameConflictError) {
          return res.status(409).json(scimError(409, err.message, "uniqueness"));
        }
        throw err;
      }
    } catch (err) {
      return next(err);
    }
  });

  // GET by ID
  router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await store.get(req.params["id"]!);
      if (user === null) {
        return res.status(404).json(scimError(404, `User not found: ${req.params["id"]}`, "noTarget"));
      }
      return res.status(200).json(user);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

/**
 * Parse a query-string integer, returning a default on missing / invalid /
 * negative input. Treats `startIndex=0` as 1 per okta-dialect.md §7 (Okta
 * may send either).
 */
function parsePositiveInt(raw: unknown, defaultValue: number): number {
  if (typeof raw !== "string") return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return defaultValue;
  return n;
}

type ScimTypeCodeForValidation = "invalidSyntax" | "invalidValue";

type ValidationResult =
  | { ok: true; input: Omit<ScimUser, "id" | "meta"> }
  | { ok: false; scimType: ScimTypeCodeForValidation; detail: string };

/**
 * Validate an incoming User POST body.
 *
 * Order matters — syntax errors (missing `schemas`) are 400+invalidSyntax;
 * semantic errors (missing required `userName`) are 400+invalidValue.
 * Okta's client may surface the scimType in admin UI, so the distinction
 * helps customers debug their integration.
 */
function validateUserBody(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, scimType: "invalidSyntax", detail: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (!Array.isArray(b["schemas"]) || !b["schemas"].includes(CORE_USER_SCHEMA)) {
    return {
      ok: false,
      scimType: "invalidSyntax",
      detail: `Body must include schemas array containing ${CORE_USER_SCHEMA}`,
    };
  }

  if (typeof b["userName"] !== "string" || b["userName"].length === 0) {
    return {
      ok: false,
      scimType: "invalidValue",
      detail: "userName is required per RFC 7643 §4.1.1",
    };
  }

  // At this point we've verified the minimum shape. Pass the body through
  // as-is; the store's typed create() takes Omit<ScimUser, "id" | "meta">,
  // and extra unknown fields (schema-extension namespaces) pass through
  // for the customer-mapping layer to consume.
  return { ok: true, input: b as unknown as Omit<ScimUser, "id" | "meta"> };
}
