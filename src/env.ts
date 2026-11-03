import type { Env } from "./types";

export const MIDDLEWARE = "cloudflare-worker";
export const VERSION = "1.0.0";
/** Identifies this worker to Dedica: `<name>/<version>`. */
export const TRANSMITTER = `${MIDDLEWARE}/${VERSION}`;

export const WELL_KNOWN_PATH = "/.well-known/dedica.json";
export const STATUS_PATH = "/__dedica/status";

export const TOKEN_HEADER = "x-dedica-middleware-token";
export const TRANSMITTER_HEADER = "x-dedica-transmitter";
export const VERSION_HEADER = "x-dedica-version";
export const CATEGORY_HEADER = "x-dedica-category";
export const SERVED_HEADER = "x-dedica-served";
/** Sent by Dedica's own crawler: always answer with the origin's page, never Dedica's. */
export const ORIGIN_FETCH_HEADER = "x-dedica-origin-fetch";

/** The settings format this worker understands. Anything else is ignored safely. */
export const SCHEMA_MAJOR = 1;

/** Every call to Dedica is abandoned after this long and the origin answers instead. */
export const POLICY_TIMEOUT_MS = 4_000;
export const SERVE_TIMEOUT_MS = 10_000;
export const HEARTBEAT_TIMEOUT_MS = 5_000;

export function apiBase(env: Env): string {
  return (env.DEDICA_API_URL ?? "").replace(/\/+$/, "");
}

export function policyUrl(env: Env): string {
  return env.DEDICA_POLICY_URL ?? `${apiBase(env)}/api/v1/middleware/policy/`;
}

export function heartbeatUrl(env: Env): string {
  return `${apiBase(env)}/api/v1/middleware/heartbeat/`;
}

/** Whether the worker has what it needs to talk to Dedica at all. */
export function configured(env: Env): boolean {
  return Boolean(env.DEDICA_SITE_ID && env.DEDICA_MIDDLEWARE_TOKEN && (env.DEDICA_API_URL || env.DEDICA_POLICY_URL));
}

/** Fetch options that keep Dedica's answers out of Cloudflare's cache (it holds credentials). */
export const NO_CACHE_CF = { cacheEverything: false, cacheTtlByStatus: { "100-599": -1 } };
