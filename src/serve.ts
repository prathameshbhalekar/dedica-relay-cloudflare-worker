/**
 * Serving from Dedica (ported from ref.js). Fetch a file from Dedica and return it as the site's
 * response, or null and the origin answers. Dedica answers 200, 304 or 428 ("ask a question first");
 * anything else, including Dedica being slow or down, falls back to the origin.
 */

import { readCapped } from "./body";
import { CATEGORY_HEADER, CONTENT_FALLBACK_HEADER, SERVED_HEADER, SERVE_TIMEOUT_MS, VERSION_HEADER, dedicaInit } from "./env";
import type { FetchFn } from "./policy";
import type { Env, Policy } from "./types";

export const MAX_SERVED_BYTES = 8 * 1024 * 1024;
const BODY_DEADLINE_MS = 10_000;
const SERVE_BACKOFF_MS = 15_000;

export interface ServeInput {
  path: string;
  search?: string;
  version?: string;
  /** `public`: same for everyone (`/llms.txt`, `/pricing.md`). `eligible`: agent version of a page URL. */
  category?: "public" | "eligible";
  /** How long Dedica may take to answer, and then to send the body (default SERVE_TIMEOUT_MS / 10 s). */
  timeoutMs?: number;
}

export class Server {
  private backoffUntil = 0;
  private identity = "";
  /** Shared by every call in flight: one failure aborts them all, so a stalled Dedica holds no request longer. */
  private circuit = new AbortController();

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly now: () => number = Date.now,
  ) {}

  /** Backs off, and releases every other call still waiting on Dedica (each falls back to the origin). */
  private failed(): void {
    this.backoffUntil = this.now() + SERVE_BACKOFF_MS;
    this.circuit.abort(new Error("dedica serving backed off"));
    this.circuit = new AbortController();
  }

  /** The Dedica URL for a path on the customer's domain, or null (serving off, backing off, or an unsafe path). */
  target(policy: Policy, input: ServeInput): { url: string; version: string } | null {
    const serve = policy.serve;
    if (!serve) return null;
    if (serve.baseUrl !== this.identity) {
      this.identity = serve.baseUrl;
      this.backoffUntil = 0;
    }
    if (this.now() < this.backoffUntil) return null;

    const base = new URL(serve.baseUrl.endsWith("/") ? serve.baseUrl : `${serve.baseUrl}/`);
    const relative = input.path.replace(/\/{2,}/g, "/").replace(/^\//, "");
    // Never let a path climb out of the serve base (it would reach other Dedica APIs with our token).
    const segments = relative.split("/").map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    if (segments.some((s) => s === "." || s === ".." || s.includes("/") || s.includes("\\"))) return null;
    const next = new URL(relative, base);
    if (next.origin !== base.origin || !next.pathname.startsWith(base.pathname)) return null;
    next.search = input.search ?? "";
    return { url: next.toString(), version: `v1:${input.version || serve.version}` };
  }

  async fromDedica(policy: Policy, env: Env, input: ServeInput, contentType: string, shared: boolean, request: Request): Promise<Response | null> {
    const target = this.target(policy, input);
    if (!target) return null;

    const timeoutMs = input.timeoutMs ?? SERVE_TIMEOUT_MS;
    const circuit = this.circuit.signal;
    // A call released by another's failure doesn't count as a failure of its own.
    const fail = (error: unknown): never => {
      if (!circuit.aborted) this.failed();
      throw error;
    };
    const headers = { ...requestHeaders(request, shared), [VERSION_HEADER]: target.version, [CATEGORY_HEADER]: input.category ?? "eligible" };
    const init = dedicaInit(env, timeoutMs, { headers, redirect: "manual" });
    init.signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), circuit]);
    const upstream = await this.fetchFn(target.url, init).catch(fail);

    // Dedica declines this one: the origin answers, and nothing is wrong (no backoff).
    if (upstream.headers.get(CONTENT_FALLBACK_HEADER) === "origin") {
      await upstream.body?.cancel().catch(() => {});
      return null;
    }
    if (upstream.status !== 200 && upstream.status !== 428 && upstream.status !== 304) {
      // 404: Dedica has nothing here (normal). Auth and server errors back off for a while.
      if (upstream.status === 401 || upstream.status === 403 || upstream.status >= 500) {
        this.failed();
        console.warn(`[dedica] serve response ${upstream.status}; using origin`);
      }
      await upstream.body?.cancel().catch(() => {});
      return null;
    }
    // A 304 only makes sense for validators the visitor sent, which are only forwarded when shared.
    if (upstream.status === 304 && !shared) return null;

    const body =
      upstream.status === 304 || request.method === "HEAD"
        ? null
        : await readServingBody(upstream, AbortSignal.any([AbortSignal.timeout(Math.min(timeoutMs, BODY_DEADLINE_MS)), circuit])).catch(fail);
    return new Response(body, { status: upstream.status, headers: responseHeaders(upstream, contentType, shared) });
  }
}

/** The visitor's headers Dedica needs. Only dedicated representations accept browser validators: a page URL may
 *  carry an HTML validator. */
function requestHeaders(request: Request, shared: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": request.headers.get("user-agent") ?? "",
    accept: request.headers.get("accept") ?? "",
  };
  if (shared) {
    for (const name of ["if-none-match", "if-modified-since"]) {
      const value = request.headers.get(name);
      if (value && value.length <= 8192) headers[name] = value;
    }
  }
  return headers;
}

/** Keep freshness and validators for shared files; never leak credentials or cookies. */
function responseHeaders(upstream: Response, contentType: string, shared: boolean): Headers {
  const cacheable = shared && (upstream.status === 200 || upstream.status === 304);
  const headers = new Headers({
    "content-type": upstream.headers.get("content-type") ?? contentType,
    [SERVED_HEADER]: "1",
    "cache-control": cacheable ? (upstream.headers.get("cache-control") ?? "no-store") : "private, no-store",
    // The user agent stays a variant: search engines deliberately get the normal page.
    vary: "accept, accept-encoding, user-agent, sec-fetch-mode, sec-fetch-dest",
  });
  if (cacheable) {
    for (const name of ["etag", "last-modified", "age", "date", "expires"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
  }
  return headers;
}

/** Reads a served body, refusing anything over 8 MB or slower than `signal` allows (default 10 s). */
export async function readServingBody(response: Response, signal: AbortSignal = AbortSignal.timeout(BODY_DEADLINE_MS)): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > MAX_SERVED_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("dedica document exceeds serving limit");
  }
  if (!response.body) return new Uint8Array(0);
  return readCapped(response.body, MAX_SERVED_BYTES, signal);
}
