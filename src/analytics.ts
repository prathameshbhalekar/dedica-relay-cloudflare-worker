/**
 * Traffic reporting (protocol v1, section 7), after each response and never in the visitor's way.
 *
 * - Every **page load** is reported: people, AI agents and bots alike. Static files (scripts, styles, images, fonts,
 *   media), the sub-requests a browser page makes (`Sec-Fetch-Dest` other than a document or frame) and prefetches
 *   are not. Neither are Dedica's own crawler and the worker's connectivity files.
 * - Events are batched per isolate and sent as NDJSON: at 1000 events, or 5 seconds after the first one. A batch
 *   Dedica can't take right now (429/503, network error) is kept and retried with the next one, up to 5000 events.
 * - No IP address leaves the edge: a visitor is a daily pseudonym, SHA-256 of IP, user agent, day and a secret salt
 *   (`DEDICA_SALT`, else the middleware token, which Dedica only stores as a hash). Only the attribution query
 *   parameters (`utm_*`, `ref`, `source`) and the policy's question parameters are kept; the referer is its origin
 *   and path only. Cookies and the token are never sent.
 */

import { clientMatch, type ClientMatch } from "./detect";
import { EVENTS_TIMEOUT_MS, NO_CACHE_CF, SERVED_HEADER, TOKEN_HEADER, TRANSMITTER, TRANSMITTER_HEADER, eventsUrl } from "./env";
import type { FetchFn } from "./policy";
import type { Ctx, Env, Policy } from "./types";

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
  client: { kind: ClientMatch["kind"]; matched: string | null; signature_agent: string | null } | null;
  user_agent: string;
  referer?: string;
  visitor?: string;
  country: string | null;
  headers: Record<string, string>;
  mode: string | null;
  policy_version: string | null;
}

export const MAX_BATCH = 1000;
export const MAX_AGE_MS = 5000;
/** How many unsent events an isolate keeps while Dedica is unavailable. */
export const MAX_BUFFERED = MAX_BATCH * 5;

const USER_AGENT_MAX = 512;
const PATH_MAX = 2048;
const QUERY_MAX = 2048;
const ASSET_EXTENSIONS = new Set([
  "js", "mjs", "css", "map", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico",
  "woff", "woff2", "ttf", "otf", "eot", "mp4", "webm", "mp3", "wav",
]); // prettier-ignore
const PAGE_DESTINATIONS = new Set(["document", "iframe", "frame"]);
/** The only query parameters reported (plus the policy's question parameters): how a visit from an AI answer is attributed. */
const KEEP_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "ref", "source"];
const REPORTED_HEADERS = ["accept", "accept-language", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-site"];

/** Whether a request is a page load worth reporting: not a static file, a browser sub-request or a prefetch. */
export function isReportable(url: URL, headers: Headers): boolean {
  const dot = url.pathname.lastIndexOf(".");
  if (dot > url.pathname.lastIndexOf("/") && ASSET_EXTENSIONS.has(url.pathname.slice(dot + 1).toLowerCase())) return false;
  const dest = headers.get("sec-fetch-dest");
  if (dest !== null && !PAGE_DESTINATIONS.has(dest)) return false;
  return !`${headers.get("sec-purpose") ?? ""} ${headers.get("purpose") ?? ""}`.includes("prefetch");
}

function questionParams(policy: Policy | null): string[] {
  const names = policy?.twins?.questionParams;
  return Array.isArray(names) ? names.filter((n) => typeof n === "string" && n.length > 0) : [];
}

/** The attribution parameters and the question asked, nothing else; capped by shortening the longest value. */
export function allowedQuery(url: URL, policy: Policy | null): string | undefined {
  const kept = new URLSearchParams();
  for (const key of KEEP_PARAMS) {
    const value = url.searchParams.get(key);
    if (value) kept.set(key, value.slice(0, 128));
  }
  for (const key of questionParams(policy)) {
    const value = url.searchParams.get(key);
    if (value) kept.set(key, value);
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

/** A daily pseudonym for the visitor. The IP itself never leaves the edge. */
async function visitorHash(headers: Headers, env: Env, now: number): Promise<string | undefined> {
  const salt = env.DEDICA_SALT || env.DEDICA_MIDDLEWARE_TOKEN;
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
  env: Env,
  startedAt: number,
  now: number,
): Promise<TrafficEvent> {
  const url = new URL(request.url);
  const client = policy ? clientMatch(request.headers, policy.detection) : null;
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
    query: allowedQuery(url, policy),
    status: response.status,
    latency_ms: Math.max(0, Math.round(now - startedAt)),
    outcome: trace.outcome,
    served_by_dedica: response.headers.get(SERVED_HEADER) === "1" || trace.outcome === "proxied" || trace.outcome === "blocked",
    category: trace.category,
    client: client && { kind: client.kind, matched: client.matched, signature_agent: client.signatureAgent },
    user_agent: (request.headers.get("user-agent") ?? "").slice(0, USER_AGENT_MAX),
    referer: refererOf(request.headers),
    visitor: await visitorHash(request.headers, env, now),
    country,
    headers,
    mode: policy?.mode ?? null,
    policy_version: policy?.version ?? null,
  };
}

/** The isolate's batch of unsent events. One per Edge; flushed by size or after MAX_AGE_MS. */
export class Reporter {
  private buffer: TrafficEvent[] = [];
  private flushPending = false;

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  get pending(): number {
    return this.buffer.length;
  }

  /** Adds an event and makes sure it gets sent: now if the batch is full, else within MAX_AGE_MS. */
  async add(event: TrafficEvent, env: Env, ctx: Ctx): Promise<void> {
    this.buffer.push(event);
    if (this.buffer.length >= MAX_BATCH) await this.flush(env);
    else this.schedule(env, ctx);
  }

  private schedule(env: Env, ctx: Ctx): void {
    if (this.flushPending) return;
    this.flushPending = true;
    ctx.waitUntil(
      (async () => {
        await this.sleep(MAX_AGE_MS);
        this.flushPending = false;
        await this.flush(env);
      })(),
    );
  }

  /** Sends one batch. Never throws; a batch Dedica can't take right now is kept for the next one. */
  async flush(env: Env): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.slice(0, MAX_BATCH);
    this.buffer = this.buffer.slice(MAX_BATCH);
    try {
      const response = await this.fetchFn(eventsUrl(env), {
        method: "POST",
        headers: {
          "content-type": "application/x-ndjson",
          [TOKEN_HEADER]: env.DEDICA_MIDDLEWARE_TOKEN ?? "",
          [TRANSMITTER_HEADER]: TRANSMITTER,
          "x-dedica-batch-id": crypto.randomUUID(),
        },
        body: batch.map((event) => JSON.stringify(event)).join("\n"),
        signal: AbortSignal.timeout(EVENTS_TIMEOUT_MS),
        cf: NO_CACHE_CF,
      } as RequestInit);
      if (response.status !== 202) {
        console.warn(`[dedica] event batch ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
      } else {
        const body = (await response.json().catch(() => null)) as { accepted?: number; rejected?: number; errors?: unknown } | null;
        if (body?.rejected) console.warn(`[dedica] events: ${body.accepted} accepted, ${body.rejected} rejected`, body.errors);
      }
      if (response.status === 429 || response.status === 503) this.requeue(batch);
    } catch (err) {
      console.warn(`[dedica] event batch request failed: ${err}`);
      this.requeue(batch);
    }
  }

  private requeue(batch: TrafficEvent[]): void {
    this.buffer = batch.concat(this.buffer).slice(0, MAX_BUFFERED);
  }
}
