import type { Env } from "./types";

export const MIDDLEWARE = "cloudflare-worker";
export const VERSION = "1.3.0";
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
/** On a Dedica response, `origin`: Dedica declines this request, and the origin answers it instead. */
export const CONTENT_FALLBACK_HEADER = "x-dedica-content-fallback";

/** The settings format this worker understands. Anything else is ignored safely. */
export const SCHEMA_MAJOR = 1;

/** Every call to Dedica is abandoned after this long and the origin answers instead. */
export const POLICY_TIMEOUT_MS = 4_000;
export const SERVE_TIMEOUT_MS = 10_000;
/** The agent version of a normal page URL: the client asked for the page, not for Dedica, so it never waits long. */
export const NEGOTIATE_TIMEOUT_MS = 1_500;
export const HEARTBEAT_TIMEOUT_MS = 5_000;
export const EVENTS_TIMEOUT_MS = 5_000;

export function apiBase(env: Env): string {
  return (env.DEDICA_API_URL ?? "").replace(/\/+$/, "");
}

/** A Dedica endpoint (`DEDICA_POLICY_URL` overrides the policy one, for testing). */
export function dedicaUrl(env: Env, endpoint: "policy" | "heartbeat" | "events"): string {
  const override = endpoint === "policy" ? env.DEDICA_POLICY_URL : undefined;
  return override ?? `${apiBase(env)}/api/v1/middleware/${endpoint}/`;
}

/** The headers that identify this worker to Dedica. */
export function dedicaHeaders(env: Env): Record<string, string> {
  return { [TOKEN_HEADER]: env.DEDICA_MIDDLEWARE_TOKEN ?? "", [TRANSMITTER_HEADER]: TRANSMITTER };
}

/** The customer's kill switch: `DEDICA_DISABLED=1` (or `true`/`yes`) and the worker only passes traffic through. */
export function disabled(env: Env): boolean {
  return /^(?:1|true|yes|on)$/i.test((env.DEDICA_DISABLED ?? "").trim());
}

/** Whether the worker has what it needs to talk to Dedica at all. */
export function configured(env: Env): boolean {
  return Boolean(env.DEDICA_SITE_ID && env.DEDICA_MIDDLEWARE_TOKEN && (env.DEDICA_API_URL || env.DEDICA_POLICY_URL));
}

/** Fetch options that keep Dedica's answers out of Cloudflare's cache (it holds credentials). */
const NO_CACHE_CF = { cacheEverything: false, cacheTtlByStatus: { "100-599": -1 } };

/** Options for a call to Dedica: this worker's identity plus `headers`, a timeout, and no Cloudflare caching. */
export function dedicaInit(env: Env, timeoutMs: number, init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}): RequestInit {
  return {
    ...init,
    headers: { ...dedicaHeaders(env), ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
    // `cf` is Cloudflare's extension of RequestInit (ignored outside Workers).
    cf: NO_CACHE_CF,
  };
}
