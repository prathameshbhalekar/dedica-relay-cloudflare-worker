/**
 * `/ask` and `/mcp` on the customer's domain, proxied to Dedica (ported from ref.js).
 *
 * The policy turns each route on independently (`query.enabled`). While `query` is null (until
 * Dedica's MCP serving ships) both routes pass through to the origin untouched. Once Dedica owns a
 * route, failures are explicit errors and never fall through to the customer's app.
 */

import { TOKEN_HEADER, TRANSMITTER, TRANSMITTER_HEADER, apiBase } from "./env";
import type { Env, Policy } from "./types";

export const QUERY_BODY_MAX = 32_768;
const QUERY_TIMEOUT_MS = 50_000;
const QUERY_BUCKET_MAX = 4096;

type Protocol = "ask" | "mcp";

export const QUERY_ROUTES: { protocol: Protocol; path: string; methods: string[] }[] = [
  { protocol: "ask", path: "/ask", methods: ["GET", "POST"] },
  { protocol: "mcp", path: "/mcp", methods: ["POST"] },
];

export const queryPath = (path: string): string => path.replace(/\/$/, "");
export const isQueryRoute = (pathname: string): boolean => QUERY_ROUTES.some((r) => r.path === queryPath(pathname));

/** Responses made by the query proxy (the caller never treats them as served pages). */
export const queryResponses = new WeakSet<Response>();

export interface QueryPorts {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  visitor: (request: Request) => string;
  now?: () => number;
}

/** The only origins a query may go to: the pinned DEDICA_QUERY_ORIGIN, else DEDICA_API_URL's. */
export function queryTarget(baseUrl: string, env: Env): URL | null {
  try {
    const target = new URL(baseUrl);
    const allowed = new URL(env.DEDICA_QUERY_ORIGIN || apiBase(env));
    const local = (u: URL) => u.hostname === "localhost" || u.hostname.endsWith(".localhost") || u.hostname === "127.0.0.1";
    const secure = (u: URL) => u.protocol === "https:" || (u.protocol === "http:" && local(u));
    if (target.username || target.password || target.hash || !secure(target) || !secure(allowed)) return null;
    return target.origin === allowed.origin ? target : null;
  } catch {
    return null;
  }
}

export function createQueryProxy(env: Env, ports: QueryPorts) {
  const now = ports.now ?? Date.now;
  const buckets = new Map<string, { count: number; reset: number }>();
  let ownership: Partial<Record<Protocol, boolean>> | undefined;

  function remember(policy: Policy): void {
    const autopilot = policy.mode === "autopilot";
    ownership = Object.fromEntries(
      QUERY_ROUTES.map(({ protocol }) => [
        protocol,
        autopilot &&
          (policy.queryAvailability?.[protocol] === "unavailable" || (Boolean(policy.query) && (policy.query?.enabled?.[protocol] ?? true))),
      ]),
    );
  }

  /** 0 when allowed, else seconds until the visitor may try again. */
  function allowVisitor(request: Request, configured: number | undefined): number {
    const limit = Number.isFinite(configured) ? Math.min(600, Math.max(1, Math.floor(configured as number))) : 30;
    const t = now();
    const key = ports.visitor(request).slice(0, 128) || "unknown";
    let bucket = buckets.get(key);
    if (!bucket || bucket.reset <= t) {
      if (buckets.size >= QUERY_BUCKET_MAX) {
        for (const [old, b] of buckets) if (b.reset <= t) buckets.delete(old);
        if (buckets.size >= QUERY_BUCKET_MAX && !bucket) return 60;
      }
      bucket = { count: 0, reset: t + 60_000 };
      buckets.set(key, bucket);
    }
    if (bucket.count >= limit) return Math.max(1, Math.ceil((bucket.reset - t) / 1000));
    bucket.count += 1;
    return 0;
  }

  return async (
    request: Request,
    readPolicy: (blocking: boolean) => Promise<Policy | null>,
    knownPolicy: Policy | null,
  ): Promise<Response | null> => {
    const url = new URL(request.url);
    const route = QUERY_ROUTES.find((r) => r.path === queryPath(url.pathname));
    if (!route || !env.DEDICA_MIDDLEWARE_TOKEN || !env.DEDICA_SITE_ID) return null;

    const reply = (status: number, code: string, extra: Record<string, string> = {}): Response => {
      const failure = {
        error: {
          code: status === 429 ? "RATE_LIMITED" : code,
          message: code.replaceAll("_", " ").toLowerCase(),
          status,
          ...(extra["retry-after"] ? { retry_after: Number(extra["retry-after"]) } : {}),
        },
      };
      const payload =
        route.protocol === "ask" ? failure : { jsonrpc: "2.0", id: null, error: { code: -32000, message: failure.error.message, data: { code, status } } };
      const response = new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json", "cache-control": "private, no-store", ...extra },
      });
      queryResponses.add(response);
      return response;
    };

    if (knownPolicy) remember(knownPolicy);
    const ownedBefore = ownership?.[route.protocol] ?? false;
    try {
      const policy = await readPolicy(true);
      if (!policy) return ownedBefore ? reply(503, "QUERY_UNAVAILABLE", { "retry-after": "1" }) : null;
      remember(policy);
      if (!ownership?.[route.protocol]) return null;
      if (policy.queryAvailability?.[route.protocol] === "unavailable") return reply(503, "QUERY_UNAVAILABLE", { "retry-after": "1" });

      const query = policy.query;
      if (!query) return null;
      if (query.askPath !== "/ask" || query.mcpPath !== "/mcp") return reply(503, "QUERY_UNAVAILABLE");
      if (!route.methods.includes(request.method)) return reply(405, "METHOD_NOT_ALLOWED", { allow: route.methods.join(", ") });
      if (url.search.length > QUERY_BODY_MAX) return reply(414, "QUERY_TOO_LARGE");
      const retryAfter = allowVisitor(request, query.requestsPerMinute);
      if (retryAfter) return reply(429, "QUERY_LIMIT_EXCEEDED", { "retry-after": String(retryAfter) });

      const base = queryTarget(query.baseUrl, env);
      if (!base) return reply(503, "QUERY_UNAVAILABLE");
      const target = new URL(`${base.pathname.replace(/\/+$/, "")}${route.path}`, base.origin);
      target.search = url.search;
      const response = await proxy(request, target.toString(), env, ports, reply);
      queryResponses.add(response);
      return response;
    } catch {
      return (ownership?.[route.protocol] ?? ownedBefore) ? reply(503, "QUERY_UNAVAILABLE") : null;
    }
  };
}

const FORWARDED_HEADERS = new Set([
  "accept",
  "content-type",
  "origin",
  "user-agent",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "mcp-protocol-version",
  "mcp-session-id",
  "mcp-method",
  "mcp-name",
  "last-event-id",
]);

function queryRequestHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({ [TOKEN_HEADER]: env.DEDICA_MIDDLEWARE_TOKEN ?? "", [TRANSMITTER_HEADER]: TRANSMITTER });
  let bytes = 0;
  for (const [name, value] of request.headers) {
    if (!FORWARDED_HEADERS.has(name) && !name.startsWith("mcp-param-")) continue;
    bytes += name.length + value.length;
    if (bytes > 16_384) throw new Error("query headers exceed limit");
    headers.set(name, value);
  }
  return headers;
}

async function queryBody(request: Request, signal: AbortSignal): Promise<Uint8Array | undefined> {
  if (!request.body) return undefined;
  if (Number(request.headers.get("content-length")) > QUERY_BODY_MAX) throw new RangeError("query body too large");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error("query aborted");
      const { value, done } = await reader.read();
      if (signal.aborted) throw new Error("query aborted");
      if (done) break;
      size += value.byteLength;
      if (size > QUERY_BODY_MAX) {
        void reader.cancel().catch(() => {});
        throw new RangeError("query body too large");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

async function proxy(
  request: Request,
  target: string,
  env: Env,
  ports: QueryPorts,
  reply: (status: number, code: string) => Response,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, QUERY_TIMEOUT_MS);
  request.signal?.addEventListener("abort", abort, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", abort);
  };
  try {
    if (request.signal?.aborted) controller.abort();
    const body = await queryBody(request, controller.signal);
    const upstream = await ports.fetch(target, {
      method: request.method,
      body,
      headers: queryRequestHeaders(request, env),
      redirect: "manual",
      signal: controller.signal,
    });
    const headers = new Headers({ "cache-control": "private, no-store", "x-dedica-served": "1", "x-accel-buffering": "no" });
    for (const name of ["content-type", "retry-after", "allow", "mcp-protocol-version", "mcp-session-id", "vary"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (!upstream.body) {
      cleanup();
      return new Response(null, { status: upstream.status, headers });
    }
    // Streamed (MCP responses may be server-sent events).
    const stream = new TransformStream();
    void upstream.body.pipeTo(stream.writable, { signal: controller.signal }).then(cleanup, () => {
      controller.abort();
      cleanup();
    });
    return new Response(stream.readable, { status: upstream.status, headers });
  } catch (error) {
    controller.abort();
    cleanup();
    return error instanceof RangeError ? reply(413, "QUERY_TOO_LARGE") : reply(502, "QUERY_UNAVAILABLE");
  }
}
