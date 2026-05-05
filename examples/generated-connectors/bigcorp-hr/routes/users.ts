/**
 * BigCorpHR-specific /Users router — extends the skeleton's users router
 * with a DELETE handler for the soft_delete lifecycle policy.
 *
 * Why not use the skeleton router directly?
 *   The skeleton's skeleton/routes/users.ts does not include a DELETE
 *   handler (it's listed as optional in okta-dialect.md §10). BigCorpHR's
 *   ticket (SCIM-LIVE-PROBE) requires `users_delete: true`, so we add it
 *   here without modifying the skeleton (BLAST-RADIUS LAW — changes to
 *   the skeleton affect ALL connectors; a customer-specific extension lives
 *   in the connector's own router).
 *
 * Soft-delete semantics per okta-dialect.md §3 and lifecycle_policy:
 * soft_delete:
 *   - DELETE /Users/{id} → marks user disabled, retains row, returns 204.
 *   - This is identical in outcome to PATCH active:false. Both paths MUST
 *     yield the same end-state (okta-dialect.md §3 anti-pattern: "inconsistency
 *     between DELETE and PATCH paths").
 *   - User not found → 404 + SCIM error envelope (okta-dialect.md §8).
 *
 * This router REPLACES (not extends) the skeleton users router in
 * createBigCorpHrConnector — it re-implements the skeleton's GET, POST,
 * PATCH handlers verbatim and adds DELETE. Future: extract shared router
 * factory to avoid duplication.
 */

import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { ScimPatchOperation } from "scim-patch";
import {
  UserNameConflictError,
} from "../../../skeleton/store/user-store.js";
import { scimError } from "../../../skeleton/middleware/error-envelope.js";
import type { ScimUser } from "../../../skeleton/types.js";
import type { BigCorpHrUserStore } from "../store.js";

const CORE_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH_OP_SCHEMA =
  "urn:ietf:params:scim:api:messages:2.0:PatchOp";

const MAX_PAGE_SIZE = 200; // matches ServiceProviderConfig filter.maxResults
const DEFAULT_PAGE_SIZE = 100; // per okta-dialect.md §7 (Okta protocol default)

export function bigCorpHrUsersRouter(store: BigCorpHrUserStore): Router {
  const router = Router();

  // ─── LIST — GET /scim/v2/Users ────────────────────────────────────────────
  router.get(
    "/",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const startIndex = parsePositiveInt(req.query["startIndex"], 1);
        const requestedCount = parsePositiveInt(
          req.query["count"],
          DEFAULT_PAGE_SIZE,
        );
        const count = Math.min(requestedCount, MAX_PAGE_SIZE);
        const filter =
          typeof req.query["filter"] === "string"
            ? req.query["filter"]
            : undefined;

        let result;
        try {
          result = await store.list({
            startIndex,
            count,
            ...(filter !== undefined && { filter }),
          });
        } catch (err) {
          // scim2-parse-filter throws on malformed filter expressions.
          // Map to 400 + invalidFilter per RFC 7644 §3.12 and
          // okta-dialect.md §8.
          return res.status(400).json(
            scimError(
              400,
              `Malformed filter: ${(err as Error).message}`,
              "invalidFilter",
            ),
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
    },
  );

  // ─── CREATE — POST /scim/v2/Users ─────────────────────────────────────────
  router.post(
    "/",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const validation = validateUserBody(req.body);
        if (!validation.ok) {
          return res
            .status(400)
            .json(scimError(400, validation.detail, validation.scimType));
        }

        try {
          const created = await store.create(validation.input);
          // 201 Created per RFC 7644 §3.3. OIN test step 10 asserts this.
          return res.status(201).json(created);
        } catch (err) {
          if (err instanceof UserNameConflictError) {
            // 409 + scimType:uniqueness per RFC 7644 §3.12 and
            // okta-dialect.md §8. OIN test step 14 asserts this.
            return res
              .status(409)
              .json(scimError(409, err.message, "uniqueness"));
          }
          throw err;
        }
      } catch (err) {
        return next(err);
      }
    },
  );

  // ─── READ — GET /scim/v2/Users/:id ────────────────────────────────────────
  router.get(
    "/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const user = await store.get(req.params["id"]!);
        if (user === null) {
          // OIN test step 6 + 22 assert 404 on nonexistent ID.
          return res
            .status(404)
            .json(
              scimError(
                404,
                `User not found: ${req.params["id"]}`,
                "noTarget",
              ),
            );
        }
        return res.status(200).json(user);
      } catch (err) {
        return next(err);
      }
    },
  );

  // ─── PATCH — PATCH /scim/v2/Users/:id ─────────────────────────────────────
  // Primary lifecycle update path per okta-dialect.md §1 + §3.
  // Okta uses this for deactivation (PATCH active:false), attribute updates,
  // and reactivation (PATCH active:true).
  // Returns 200 + full resource body — okta-dialect.md §1: "Okta expects
  // 200 + full resource body on PATCH, NOT 204 No Content."
  router.patch(
    "/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const validation = validatePatchBody(req.body);
        if (!validation.ok) {
          return res
            .status(400)
            .json(scimError(400, validation.detail, "invalidSyntax"));
        }

        try {
          const updated = await store.patch(
            req.params["id"]!,
            validation.operations,
          );
          if (updated === null) {
            return res
              .status(404)
              .json(
                scimError(
                  404,
                  `User not found: ${req.params["id"]}`,
                  "noTarget",
                ),
              );
          }
          return res.status(200).json(updated);
        } catch (err) {
          if (err instanceof UserNameConflictError) {
            return res
              .status(409)
              .json(scimError(409, err.message, "uniqueness"));
          }
          throw err;
        }
      } catch (err) {
        return next(err);
      }
    },
  );

  // ─── DELETE — DELETE /scim/v2/Users/:id ───────────────────────────────────
  // Soft-delete implementation per okta-dialect.md §3 and ticket
  // SCIM-LIVE-PROBE lifecycle_policy: soft_delete.
  //
  // What happens:
  //   1. Store calls client.deleteUser(id) → PATCHes enabled:false on BigCorpHR
  //   2. User row is retained (compliance / 7-year audit retention)
  //   3. Returns 204 No Content on success (standard DELETE response per RFC 7644)
  //   4. Returns 404 when user is not found
  //
  // okta-dialect.md §3: "DELETE endpoint may be implemented for edge cases
  // (admin-initiated forced removal on the customer app side) but Okta itself
  // drives lifecycle through the `active` flag." We implement it here to satisfy
  // users_delete:true from the ticket while maintaining soft_delete policy.
  //
  // okta-dialect.md §3 anti-pattern check: "Inconsistency between DELETE and
  // PATCH paths — same customer policy MUST yield identical outcomes regardless
  // of which endpoint Okta hits." Both paths set enabled:false and retain the row.
  router.delete(
    "/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const deactivated = await store.delete(req.params["id"]!);
        if (deactivated === null) {
          return res
            .status(404)
            .json(
              scimError(
                404,
                `User not found: ${req.params["id"]}`,
                "noTarget",
              ),
            );
        }
        // 204 No Content — standard successful DELETE per RFC 7644 §3.6.
        // No body. Consistent with the soft_delete outcome (user is gone
        // from Okta's perspective even though BigCorpHR retains the row).
        return res.status(204).send();
      } catch (err) {
        return next(err);
      }
    },
  );

  return router;
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function parsePositiveInt(raw: unknown, defaultValue: number): number {
  if (typeof raw !== "string") return defaultValue;
  const n = Number.parseInt(raw, 10);
  // Treat 0 as 1 per okta-dialect.md §7 (Okta may send startIndex:0).
  if (!Number.isFinite(n) || n < 1) return defaultValue;
  return n;
}

type ScimTypeCodeForValidation = "invalidSyntax" | "invalidValue";

type ValidationResult =
  | { ok: true; input: Omit<ScimUser, "id" | "meta"> }
  | { ok: false; scimType: ScimTypeCodeForValidation; detail: string };

function validateUserBody(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null) {
    return {
      ok: false,
      scimType: "invalidSyntax",
      detail: "Request body must be a JSON object",
    };
  }
  const b = body as Record<string, unknown>;

  if (
    !Array.isArray(b["schemas"]) ||
    !b["schemas"].includes(CORE_USER_SCHEMA)
  ) {
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

  return { ok: true, input: b as unknown as Omit<ScimUser, "id" | "meta"> };
}

type PatchValidationResult =
  | { ok: true; operations: ScimPatchOperation[] }
  | { ok: false; detail: string };

function validatePatchBody(body: unknown): PatchValidationResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, detail: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (
    !Array.isArray(b["schemas"]) ||
    !b["schemas"].includes(PATCH_OP_SCHEMA)
  ) {
    return {
      ok: false,
      detail: `PATCH body must include schemas array containing ${PATCH_OP_SCHEMA}`,
    };
  }

  if (!Array.isArray(b["Operations"]) || b["Operations"].length === 0) {
    return {
      ok: false,
      detail: "PATCH body must include a non-empty Operations array",
    };
  }

  return {
    ok: true,
    operations: b["Operations"] as ScimPatchOperation[],
  };
}