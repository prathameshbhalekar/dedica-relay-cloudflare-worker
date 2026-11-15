/**
 * Traffic events (protocol v1, section 7): what is reported about a request. Sent by reporter.ts.
 *
 * - Every **page load** is reported: people, AI agents and bots alike. Static files (scripts, styles, images, fonts,
 *   media), the sub-requests a browser page makes (`Sec-Fetch-Dest` other than a document or frame) and prefetches
 *   are not. Neither are Dedica's own crawler and the worker's connectivity files.
 * - Events are batched per isolate and sent as NDJSON: at 1000 events, or 5 seconds after the first one. A batch
 *   Dedica can't take right now (429/503, network error) is kept and retried with the next one, up to 5000 events.
 * - No IP address leaves the edge: a visitor is a daily pseudonym, SHA-256 of IP, user agent, day and a secret salt
 *   (`DEDICA_SALT`; without it no pseudonym is sent). Only the attribution query
 *   parameters (`utm_*`, `ref`, `source`) and the policy's question parameters are kept; the referer is its origin
 *   and path only. Cookies and the token are never sent.
 */

import type { Env } from "../config";
import type { BlockRule } from "../decide/access";
import type { Category, Outcome } from "../decide/decision";
import type { Identity, Tier } from "../identity/verdict";
import type { Policy } from "../policy/compile";
import { SERVED_HEADER } from "../protocol";
import { type Client, clientKind } from "../request/classify";

/** How the worker answered a request, turned into an event. */
export interface Trace {
  outcome: Outcome;
  category: Category;
  /** The Agent Access rule that answered 403, if any. */
  blockRule?: BlockRule;
}

export interface TrafficEvent {
  id: string;
  ts: string;
  method: string;
  host: string;
  path: string;
  query?: string;
  status: number;
  latency_ms: number;
  outcome: Outcome;
  served_by_dedica: boolean;
  category: "public" | "eligible" | null;
  /** Null when the worker has no policy yet (the detection lists come from it). */
  client: {
    kind: ReturnType<typeof clientKind>;
    matched: string | null;
    signature_agent: string | null;
    /** Who the bot really is (Agent Access); absent without verification data in the policy. Never the IP. */
    verification?: Tier;
    /** The catalog key of the agent the verification named. */
    agent?: string | null;
  } | null;
  block_rule?: BlockRule;
  user_agent: string;
  referer?: string;
  visitor?: string;
  country: string | null;
  headers: Record<string, string>;
  mode: string | null;
  policy_version: string | null;
}

const USER_AGENT_MAX = 512;
const PATH_MAX = 2048;
const QUERY_MAX = 2048;
/** The only query parameters reported: how a visit from an AI answer is attributed. */
const KEEP_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "ref", "source"];
const REPORTED_HEADERS = ["accept", "accept-language", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-site"];

/** The attribution parameters, nothing else; capped by shortening the longest value. */
export function allowedQuery(url: URL): string | undefined {
  const kept = new URLSearchParams();
  for (const key of KEEP_PARAMS) {
    const value = url.searchParams.get(key);
    if (value) kept.set(key, value.slice(0, 128));
  }
  let qs = kept.toString();
  while (qs.length + 1 > QUERY_MAX) {
    const [key, value] = [...kept].reduce((a, b) => (b[1].length > a[1].length ? b : a));
    if (!value) break;
    kept.set(key, value.slice(0, Math.max(0, value.length - (qs.length + 1 - QUERY_MAX))));
    qs = kept.toString();
  }
  return qs ? `?${qs}` : undefined;
}

/** The page a visitor came from, as origin and path only: another site's query string can carry anything. */
function refererOf(headers: Headers): string | undefined {
  const raw = headers.get("referer");
  if (!raw) return undefined;
  try {
    const ref = new URL(raw);
    return `${ref.origin}${ref.pathname}`.slice(0, PATH_MAX);
  } catch {
    return undefined;
  }
}

/** A daily pseudonym for the visitor. The IP itself never leaves the edge. No `DEDICA_SALT`, no pseudonym: the
 *  token is never a fallback, since Dedica sees it on every call and could reverse the hash. */
async function visitorHash(headers: Headers, env: Env, now: number): Promise<string | undefined> {
  const salt = env.DEDICA_SALT;
  const ip = headers.get("cf-connecting-ip");
  if (!salt || !ip) return undefined;
  const day = new Date(now).toISOString().slice(0, 10);
  const data = new TextEncoder().encode(`${ip}|${headers.get("user-agent") ?? ""}|${day}|${salt}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The event for this request. */
export async function buildEvent(
  request: Request,
  response: Response,
  trace: Trace,
  policy: Policy | null,
  /** Who the client looks like under `policy` (null without one). */
  client: Client | null,
  env: Env,
  startedAt: number,
  now: number,
  identity: Identity | null = null,
): Promise<TrafficEvent> {
  const url = new URL(request.url);
  const verdict = identity ? { verification: identity.tier, agent: identity.agent } : {};
  const headers: Record<string, string> = {};
  for (const name of REPORTED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value.slice(0, 256);
  }
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  const country = request.headers.get("cf-ipcountry") ?? (typeof cf?.country === "string" ? cf.country : null);
  return {
    id: crypto.randomUUID(),
    ts: new Date(now).toISOString(),
    method: request.method,
    host: url.host,
    path: url.pathname.slice(0, PATH_MAX),
    query: allowedQuery(url),
    status: response.status,
    latency_ms: Math.max(0, Math.round(now - startedAt)),
    outcome: trace.outcome,
    served_by_dedica: response.headers.get(SERVED_HEADER) === "1" || trace.outcome === "proxied" || trace.outcome === "blocked",
    category: trace.category,
    client: client && { kind: clientKind(client), matched: client.matched, signature_agent: client.signer, ...verdict },
    block_rule: trace.blockRule,
    user_agent: (request.headers.get("user-agent") ?? "").slice(0, USER_AGENT_MAX),
    referer: refererOf(request.headers),
    visitor: await visitorHash(request.headers, env, now),
    country,
    headers,
    mode: policy?.mode ?? null,
    policy_version: policy?.version ?? null,
  };
}

