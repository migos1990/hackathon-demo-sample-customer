/**
 * Ticket validator — AJV wrap around ticket-templates/schema.json.
 *
 * The orchestrator's validate-before-dispatch step calls this. Malformed
 * tickets must NEVER reach the agent — the agent treats ticket YAML as
 * ground truth for customer intent; a schema violation is a bouncing
 * error, not a gentle-guidance warning.
 *
 * Design:
 *   - Schema is loaded from disk on module import. Compilation is done
 *     once and cached — downstream callers call validateTicket() many
 *     times per orchestrator run.
 *   - AJV `allErrors: true` so the full error list comes back on one
 *     pass. Partial-fail one-error-at-a-time UX is hostile.
 *   - Errors normalize to { path, message } so callers don't couple to
 *     AJV's error shape. Adds future-proofing for a schema-lib swap.
 *
 * Pairs with scripts/validators/scim-compliance.ts (validates what the
 * connector advertises) — this one validates what the ticket asks for.
 */
// Use Ajv2020 because ticket-templates/schema.json uses draft 2020-12.
// The default Ajv (draft-07) doesn't know how to resolve the $schema
// reference `https://json-schema.org/draft/2020-12/schema` and throws
// "no schema with key or ref ..." on compile.
import Ajv from "ajv/dist/2020.js";
import type { ValidateFunction, ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "..", "ticket-templates", "schema.json");

export interface ValidationError {
  /** JSON pointer path into the ticket (e.g. "/customer_slug"). Empty for root. */
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

let compiledValidator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (compiledValidator) return compiledValidator;
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as object;
  compiledValidator = ajv.compile(schema);
  return compiledValidator;
}

export function validateTicket(ticket: unknown): ValidationResult {
  const validate = getValidator();
  const ok = validate(ticket);
  if (ok) return { ok: true, errors: [] };

  const rawErrors = validate.errors ?? [];
  return {
    ok: false,
    errors: rawErrors.map(normalizeError),
  };
}

function normalizeError(err: ErrorObject): ValidationError {
  const path = err.instancePath ?? "";
  // AJV keyword messages are terse ("must match pattern '...'"). Build a
  // more useful sentence by combining the path + keyword + params when
  // available.
  const base = err.message ?? "validation failed";
  const params = err.params ? formatParams(err.params) : "";
  const prefix = path ? `${path}: ` : "";
  const suffix = params ? ` (${params})` : "";
  return { path, message: `${prefix}${base}${suffix}` };
}

function formatParams(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "object") continue; // skip nested structures — noise
    parts.push(`${k}=${String(v)}`);
  }
  return parts.join(", ");
}
