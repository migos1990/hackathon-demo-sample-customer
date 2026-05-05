/**
 * Structured JSON logger for the SCIM skeleton + connectors.
 *
 * Closes Connector Law 8 (OBSERVABLE) alongside /healthz + request-id
 * middleware. Every log line is a single JSON object with ts, level, msg,
 * and merged context fields. Consumers pipe stdout/stderr to whatever
 * they like — CloudWatch, Loki, Datadog.
 *
 * Secret hygiene: known secret-header names (authorization, cookie) are
 * redacted before serialization. The skeleton has ALREADY type-tested
 * against leaking raw tokens in logs via skeleton/middleware/auth.test.ts;
 * this is defense in depth.
 *
 * No external deps — console-level output + JSON.stringify. A proper
 * logger (pino, winston) adds value only at volume this app won't hit
 * during a demo. Adding the dep is Day-11+ work if real prod scale
 * ever arrives.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_RANK: Record<Exclude<LogLevel, "silent">, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  /** Returns a new logger that merges these fields into every line. */
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  /** Write fn; defaults to stdout for info/debug, stderr for warn/error. */
  write?: (line: string) => void;
  /** Minimum level to emit. "silent" disables all output. Defaults to "info". */
  level?: LogLevel;
  /** Base fields merged into every log line. */
  base?: Record<string, unknown>;
}

const SECRET_HEADER_NAMES = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization"]);
const REDACTED = "[REDACTED]";

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? "info";
  const defaultWrite = opts.write ?? defaultWriter;
  const base = opts.base ?? {};

  function emit(lvl: Exclude<LogLevel, "silent">, msg: string, fields?: Record<string, unknown>): void {
    if (level === "silent") return;
    if (LEVEL_RANK[lvl] < LEVEL_RANK[level as Exclude<LogLevel, "silent">]) return;

    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...base,
      ...(fields ?? {}),
    };

    const serialized = safeStringify(redact(record));
    defaultWrite(serialized);
  }

  return {
    debug(msg, fields) { emit("debug", msg, fields); },
    info(msg, fields) { emit("info", msg, fields); },
    warn(msg, fields) { emit("warn", msg, fields); },
    error(msg, fields) { emit("error", msg, fields); },
    child(fields) {
      return createLogger({
        ...opts,
        base: { ...base, ...fields },
      });
    },
  };
}

function defaultWriter(line: string): void {
  // Route warn/error to stderr via the presence of level in the serialized line.
  // Simple heuristic — parse only when needed to avoid double-work.
  if (line.includes('"level":"error"') || line.includes('"level":"warn"')) {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

/**
 * Walk the object, redact values for known-secret keys regardless of
 * case. Does NOT mutate the input. Handles nested objects and arrays.
 * Errors get a basic { name, message } projection so they aren't lost
 * to JSON.stringify's default behavior.
 */
function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_HEADER_NAMES.has(k.toLowerCase())) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, seen);
    }
  }
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    // Shouldn't reach here — redact() handles cycles — but fall back so a
    // logger fault never takes down a request. UNVERIFIED: no test covers
    // this branch because we can't produce a value that survives redact()'s
    // cycle handling and still breaks stringify. Kept as defensive fallback.
    return JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "logger_stringify_failed" });
  }
}
