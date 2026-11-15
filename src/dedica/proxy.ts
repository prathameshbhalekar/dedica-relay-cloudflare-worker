/**
 * Paths on the customer's domain that the policy proxies to Dedica (`/ask`, `/mcp`, ...).
 *
 * The policy alone names them: each entry of `policy.proxies` is a path plus, per method it takes, the Dedica URL
 * that answers it. Nothing is hardcoded. Dedica's own answers, errors included, are relayed as they are, streamed.
 */

import { apiBase, type Env } from "../config";
import type { Policy } from "../policy/types";
import { CONTENT_FALLBACK_HEADER, PROXY_BODY_MAX, PROXY_HEADERS_MAX, PROXY_TIMEOUT_MS, SERVED_HEADER } from "../protocol";
import { trimTrailingSlashes } from "../util/paths";
import { readCapped } from "../util/stream";
import { type DedicaClient, identityHeaders } from "./client";

/** The Dedica URL the policy proxies this path and method to, or null. Only in autopilot. */
export function proxyRoute(url: URL, method: string, policy: Policy | null): string | null {
  if (!policy || policy.mode !== "autopilot") return null;
  const path = trimTrailingSlashes(url.pathname);
  const route = policy.proxies.find((p) => /^\/[^?#\s]+$/.test(p.path) && trimTrailingSlashes(p.path) === path);
  // `Object.hasOwn`: a method named like an Object.prototype member (`constructor`) is not a target.
  const target = route && Object.hasOwn(route.targets, method) ? route.targets[method] : undefined;
  return typeof target === "string" ? target : null;
}

/**
 * Where to send a proxied request: the policy's target with the visitor's query string, or null when it may not be
 * sent (a target off the pinned origin, not https, carrying credentials or a fragment, or a query that is too long).
 */
export function proxyTarget(targetUrl: string, url: URL, env: Env): URL | null {
  if (url.search.length > PROXY_BODY_MAX) return null;
  try {
    const target = new URL(targetUrl);
    const allowed = new URL(env.DEDICA_QUERY_ORIGIN || apiBase(env));
    const local = (u: URL) => u.hostname === "localhost" || u.hostname.endsWith(".localhost") || u.hostname === "127.0.0.1";
    const secure = (u: URL) => u.protocol === "https:" || (u.protocol === "http:" && local(u));
    if (target.username || target.password || target.hash || !secure(target) || !secure(allowed)) return null;
    if (target.origin !== allowed.origin) return null;
    target.search = url.search;
    return target;
  } catch {
    return null;
  }
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

const RELAYED_HEADERS = ["content-type", "retry-after", "allow", "mcp-protocol-version", "mcp-session-id", "vary"];

function forwardedHeaders(request: Request, env: Env): Headers {
  const headers = new Headers(identityHeaders(env));
  let bytes = 0;
  for (const [name, value] of request.headers) {
    if (!FORWARDED_HEADERS.has(name) && !name.startsWith("mcp-param-")) continue;
    bytes += name.length + value.length;
    if (bytes > PROXY_HEADERS_MAX) throw new Error("proxy headers exceed limit");
    headers.set(name, value);
  }
  return headers;
}

async function forwardedBody(request: Request, signal: AbortSignal): Promise<Uint8Array | undefined> {
  if (!request.body) return undefined;
  if (Number(request.headers.get("content-length")) > PROXY_BODY_MAX) throw new RangeError("proxy body too large");
  return readCapped(request.body, PROXY_BODY_MAX, signal);
}

/**
 * Dedica's answer for a proxied path, streamed; null when Dedica can't be reached, declines the request, or the
 * request is too large. `request` is the visitor's: it is cloned, so the origin still gets the body.
 */
export async function proxy(request: Request, target: URL, env: Env, client: DedicaClient): Promise<Response | null> {
  const visitor = request.clone();
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, PROXY_TIMEOUT_MS);
  visitor.signal?.addEventListener("abort", abort, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    visitor.signal?.removeEventListener("abort", abort);
  };
  try {
    if (visitor.signal?.aborted) controller.abort();
    const body = await forwardedBody(visitor, controller.signal);
    const upstream = await client.proxy(target.toString(), {
      method: visitor.method,
      body,
      headers: forwardedHeaders(visitor, env),
      signal: controller.signal,
    });
    // Dedica declines this one: the origin answers (it still has the original body).
    if (upstream.headers.get(CONTENT_FALLBACK_HEADER) === "origin") {
      controller.abort();
      cleanup();
      void upstream.body?.cancel().catch(() => {});
      return null;
    }
    const headers = new Headers({ "cache-control": "private, no-store", [SERVED_HEADER]: "1", "x-accel-buffering": "no" });
    for (const name of RELAYED_HEADERS) {
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
