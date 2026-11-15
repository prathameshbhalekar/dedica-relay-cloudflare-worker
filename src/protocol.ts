/** The Dedica middleware protocol as this worker speaks it: names, paths, headers, time limits and size limits. */

export const MIDDLEWARE = "cloudflare-worker";
export const VERSION = "1.4.0";
/** Identifies this worker to Dedica: `<name>/<version>`. */
export const TRANSMITTER = `${MIDDLEWARE}/${VERSION}`;

/** The settings format this worker understands. Anything else is ignored safely. */
export const SCHEMA_MAJOR = 1;

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

// Every call to Dedica is abandoned after its time limit, and the origin answers instead.
export const POLICY_TIMEOUT_MS = 4_000;
export const SERVE_TIMEOUT_MS = 10_000;
/** The agent version of a normal page URL: the client asked for the page, not for Dedica, so it never waits long. */
export const NEGOTIATE_TIMEOUT_MS = 1_500;
/** How long a served body may take to arrive (capped by the call's own time limit). */
export const SERVE_BODY_DEADLINE_MS = 10_000;
export const PROXY_TIMEOUT_MS = 50_000;
export const HEARTBEAT_TIMEOUT_MS = 5_000;
export const EVENTS_TIMEOUT_MS = 5_000;

/** After a failed serve call, Dedica is left alone this long. */
export const SERVE_BACKOFF_MS = 15_000;

export const MAX_SERVED_BYTES = 8 * 1024 * 1024;
/** A proxied request's body, and its query string, at most. */
export const PROXY_BODY_MAX = 32_768;
/** The visitor headers forwarded on a proxied request (names plus values), at most. */
export const PROXY_HEADERS_MAX = 16_384;
/** Longer user agents are cut before any matching, so a policy pattern never runs over an attacker-sized string. */
export const UA_MATCH_MAX = 512;

export const TEXT = "text/plain; charset=utf-8";
