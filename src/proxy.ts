/**
 * Paths on the customer's domain that the policy proxies to Dedica (`/ask`, `/mcp`, ...).
 *
 * The policy alone names them: each entry of `policy.proxies` is a path plus, per method it takes, the
 * Dedica URL that answers it. Nothing is hardcoded. Anything the worker can't hand to Dedica (no policy,
 * an unlisted path or method, a body too large, a target off Dedica's origin, Dedica unreachable)
 * returns null, and the origin answers. Dedica's own answers, errors included, are relayed as they are.
 */

import { TOKEN_HEADER, TRANSMITTER, TRANSMITTER_HEADER, apiBase } from "./env";
import type { Env, Policy } from "./types";

const PROXY_BODY_MAX = 32_768;
const PROXY_TIMEOUT_MS = 50_000;

const normalPath = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/** The only origins a request may be proxied to: the pinned DEDICA_QUERY_ORIGIN, else DEDICA_API_URL's. */
export function proxyTarget(targetUrl: string, env: Env): URL | null {
  try {
    const target = new URL(targetUrl);
    const allowed = new URL(env.DEDICA_QUERY_ORIGIN || apiBase(env));
    const local = (u: URL) => u.hostname === "localhost" || u.hostname.endsWith(".localhost") || u.hostname === "127.0.0.1";
    const secure = (u: URL) => u.protocol === "https:" || (u.protocol === "http:" && local(u));
    if (target.username || target.password || target.hash || !secure(target) || !secure(allowed)) return null;
    return target.origin === allowed.origin ? target : null;
  } catch {
    return null;
  }
}

/** Dedica's answer for a proxied path on the customer's domain, or null and the origin answers. */
export async function proxyRequest(
  request: Request,
  policy: Policy | null,
  env: Env,
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
): Promise<Response | null> {
  if (!policy || policy.mode !== "autopilot" || !Array.isArray(policy.proxies) || !env.DEDICA_MIDDLEWARE_TOKEN) return null;
  const url = new URL(request.url);
  const route = policy.proxies.find((p) => typeof p?.path === "string" && /^\/[^?#\s]+$/.test(p.path) && normalPath(p.path) === normalPath(url.pathname));
  const targetUrl = route?.targets?.[request.method];
  if (typeof targetUrl !== "string" || url.search.length > PROXY_BODY_MAX) return null;
  const target = proxyTarget(targetUrl, env);
  if (!target) return null;
  target.search = url.search;
  // A clone, so the origin still gets the body if Dedica doesn't answer.
  return forward(request.clone(), target.toString(), env, fetchFn);
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

function proxyHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({ [TOKEN_HEADER]: env.DEDICA_MIDDLEWARE_TOKEN ?? "", [TRANSMITTER_HEADER]: TRANSMITTER });
  let bytes = 0;
  for (const [name, value] of request.headers) {
    if (!FORWARDED_HEADERS.has(name) && !name.startsWith("mcp-param-")) continue;
    bytes += name.length + value.length;
    if (bytes > 16_384) throw new Error("proxy headers exceed limit");
    headers.set(name, value);
  }
  return headers;
}

async function proxyBody(request: Request, signal: AbortSignal): Promise<Uint8Array | undefined> {
  if (!request.body) return undefined;
  if (Number(request.headers.get("content-length")) > PROXY_BODY_MAX) throw new RangeError("proxy body too large");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error("proxy aborted");
      const { value, done } = await reader.read();
      if (signal.aborted) throw new Error("proxy aborted");
      if (done) break;
      size += value.byteLength;
      if (size > PROXY_BODY_MAX) {
        void reader.cancel().catch(() => {});
        throw new RangeError("proxy body too large");
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

/** Dedica's response, streamed; null when it can't be reached or the body is too large. */
async function forward(
  request: Request,
  target: string,
  env: Env,
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
): Promise<Response | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, PROXY_TIMEOUT_MS);
  request.signal?.addEventListener("abort", abort, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", abort);
  };
  try {
    if (request.signal?.aborted) controller.abort();
    const body = await proxyBody(request, controller.signal);
    const upstream = await fetchFn(target, {
      method: request.method,
      body,
      headers: proxyHeaders(request, env),
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
  } catch {
    controller.abort();
    cleanup();
    return null;
  }
}
