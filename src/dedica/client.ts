/**
 * Every call to Dedica goes through here: the token and transmitter headers, the time limit, and no Cloudflare
 * caching (the calls carry credentials). Nothing else in the worker builds a request to Dedica.
 */

import { apiBase, type Env } from "../config";
import {
  EVENTS_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_MS,
  MIDDLEWARE,
  POLICY_TIMEOUT_MS,
  TOKEN_HEADER,
  TRANSMITTER,
  TRANSMITTER_HEADER,
  VERSION,
} from "../protocol";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Fetch options that keep Dedica's answers out of Cloudflare's cache. */
const NO_CACHE_CF = { cacheEverything: false, cacheTtlByStatus: { "100-599": -1 } };

/** The headers that identify this worker to Dedica. */
export function identityHeaders(env: Env): Record<string, string> {
  return { [TOKEN_HEADER]: env.DEDICA_MIDDLEWARE_TOKEN ?? "", [TRANSMITTER_HEADER]: TRANSMITTER };
}

/** A Dedica API endpoint (`DEDICA_POLICY_URL` overrides the policy one, for testing). */
function endpoint(env: Env, name: "policy" | "heartbeat" | "events"): string {
  const override = name === "policy" ? env.DEDICA_POLICY_URL : undefined;
  return override ?? `${apiBase(env)}/api/v1/middleware/${name}/`;
}

interface CallInit {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  redirect?: RequestInit["redirect"];
  /** Ends the call early (on top of the time limit). */
  signal?: AbortSignal;
}

export class DedicaClient {
  constructor(private readonly fetchFn: FetchFn) {}

  private call(env: Env, url: string, timeoutMs: number, init: CallInit = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const { signal, headers, ...rest } = init;
    return this.fetchFn(url, {
      ...rest,
      headers: { ...identityHeaders(env), ...headers },
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      // `cf` is Cloudflare's extension of RequestInit (ignored outside Workers).
      cf: NO_CACHE_CF,
    });
  }

  policy(env: Env): Promise<Response> {
    return this.call(env, endpoint(env, "policy"), POLICY_TIMEOUT_MS, { headers: { accept: "application/json" } });
  }

  heartbeat(env: Env): Promise<Response> {
    return this.call(env, endpoint(env, "heartbeat"), HEARTBEAT_TIMEOUT_MS, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ middleware: MIDDLEWARE, version: VERSION }),
    });
  }

  /** One batch of traffic events, as NDJSON. */
  events(env: Env, ndjson: string): Promise<Response> {
    return this.call(env, endpoint(env, "events"), EVENTS_TIMEOUT_MS, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson", "x-dedica-batch-id": crypto.randomUUID() },
      body: ndjson,
    });
  }

  /** A document from the serve endpoint. Redirects are never followed. */
  document(env: Env, url: string, headers: Record<string, string>, timeoutMs: number, signal: AbortSignal): Promise<Response> {
    return this.call(env, url, timeoutMs, { headers, redirect: "manual", signal });
  }

  /**
   * A request on a proxied path (`/ask`, `/mcp`). The caller owns the time limit (it covers streaming the answer
   * too), and the answer may be cached by nobody but is not marked for Cloudflare: proxied answers are `no-store`.
   */
  proxy(url: string, init: { method: string; body?: Uint8Array; headers: Headers; signal: AbortSignal }): Promise<Response> {
    return this.fetchFn(url, { ...init, redirect: "manual" });
  }
}
