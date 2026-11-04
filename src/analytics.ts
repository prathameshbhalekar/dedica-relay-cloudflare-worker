/**
 * Traffic reporting (protocol v1, section 7): one event per request from an AI agent or a bot, or answered by
 * Dedica, sent in the background after the response. It never delays or changes a response, and any failure is
 * dropped with one log line (fail open). Ordinary human page views are never reported, and neither are IP
 * addresses, query strings, cookies or the token.
 */

import { clientMatch, type ClientMatch } from "./detect";
import { EVENTS_TIMEOUT_MS, NO_CACHE_CF, SERVED_HEADER, TOKEN_HEADER, TRANSMITTER, TRANSMITTER_HEADER, eventsUrl } from "./env";
import type { FetchFn } from "./policy";
import type { Env, Policy } from "./types";

/** What the worker did with a request. */
export type Outcome =
  | "proxied" // a path the policy proxies to Dedica (`/mcp`, `/ask`, ...)
  | "artifact" // a file Dedica manages (`/llms.txt`, ...), from Dedica
  | "artifact_origin" // a `fallback` file the origin has itself
  | "blocked" // a file the policy blocks
  | "twin" // an explicit markdown URL (`/pricing.md`)
  | "negotiated" // the agent version of a normal page URL
  | "human_page" // a search engine, preview or unknown crawler kept the normal page
  | "agent_404" // the origin's 404/410 with a markdown body for an agent
  | "origin"; // passed through to the origin

/** Filled in while a request is handled, then turned into an event. */
export interface Trace {
  outcome: Outcome;
  category: "public" | "eligible" | null;
}

export function newTrace(): Trace {
  return { outcome: "origin", category: null };
}

export interface TrafficEvent {
  ts: string;
  method: string;
  host: string;
  path: string;
  status: number;
  latency_ms: number;
  outcome: Outcome;
  served_by_dedica: boolean;
  category: "public" | "eligible" | null;
  client: { kind: ClientMatch["kind"]; matched: string | null; signature_agent: string | null };
  user_agent: string;
  country: string | null;
  mode: string;
  policy_version: string;
}

const USER_AGENT_MAX = 512;

/** The event for this request, or null when it isn't reported (a person's page view). */
export function buildEvent(
  request: Request,
  response: Response,
  trace: Trace,
  policy: Policy,
  startedAt: number,
  now: number,
): TrafficEvent | null {
  const client = clientMatch(request.headers, policy.detection);
  const servedByDedica = response.headers.get(SERVED_HEADER) === "1" || trace.outcome === "proxied" || trace.outcome === "blocked";
  if (client.kind === "unknown" && !servedByDedica) return null;

  const url = new URL(request.url);
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  return {
    ts: new Date(now).toISOString(),
    method: request.method,
    host: url.host,
    path: url.pathname,
    status: response.status,
    latency_ms: Math.max(0, Math.round(now - startedAt)),
    outcome: trace.outcome,
    served_by_dedica: servedByDedica,
    category: trace.category,
    client: { kind: client.kind, matched: client.matched, signature_agent: client.signatureAgent },
    user_agent: (request.headers.get("user-agent") ?? "").slice(0, USER_AGENT_MAX),
    country: typeof cf?.country === "string" ? cf.country : null,
    mode: policy.mode,
    policy_version: policy.version,
  };
}

/** Posts one event to Dedica. Never throws. */
export async function sendEvent(event: TrafficEvent, env: Env, fetchFn: FetchFn): Promise<void> {
  try {
    const response = await fetchFn(eventsUrl(env), {
      method: "POST",
      headers: { "content-type": "application/json", [TOKEN_HEADER]: env.DEDICA_MIDDLEWARE_TOKEN ?? "", [TRANSMITTER_HEADER]: TRANSMITTER },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(EVENTS_TIMEOUT_MS),
      cf: NO_CACHE_CF,
    } as RequestInit);
    if (!response.ok) console.warn(`[dedica] event report failed: ${response.status}`);
    void response.body?.cancel().catch(() => {});
  } catch (err) {
    console.warn(`[dedica] event report request failed: ${err}`);
  }
}
