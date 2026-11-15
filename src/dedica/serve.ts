/**
 * Serving from Dedica: fetch a document (`/llms.txt`, `/pricing.md`, the agent version of a page) and return it as
 * the site's response, or null and the origin answers. Dedica answers 200, 304 or 428 ("ask a question first");
 * anything else, including Dedica being slow or down, falls back to the origin.
 */

import type { Env } from "../config";
import type { Policy } from "../policy/types";
import {
  CATEGORY_HEADER,
  CONTENT_FALLBACK_HEADER,
  MAX_SERVED_BYTES,
  SERVED_HEADER,
  SERVE_BODY_DEADLINE_MS,
  SERVE_TIMEOUT_MS,
  VERSION_HEADER,
} from "../protocol";
import { readCapped } from "../util/stream";
import type { CircuitBreaker } from "./circuit";
import type { DedicaClient } from "./client";

/** What to fetch from Dedica, and how to answer with it. */
export interface DocRequest {
  path: string;
  search?: string;
  version?: string;
  /** `public`: same for everyone (`/llms.txt`, `/pricing.md`). `eligible`: agent version of a page URL. */
  category: "public" | "eligible";
  /** Used when Dedica sends no content type. */
  contentType: string;
  /** Cacheable by shared caches: validators are forwarded, and freshness headers kept. */
  shared: boolean;
  /** How long Dedica may take to answer, and then to send the body (default SERVE_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** The serve URL for a path on the customer's domain, or null when the path would climb out of the serve base. */
export function serveTarget(serve: NonNullable<Policy["serve"]>, doc: Pick<DocRequest, "path" | "search" | "version">): { url: string; version: string } | null {
  const base = new URL(serve.baseUrl.endsWith("/") ? serve.baseUrl : `${serve.baseUrl}/`);
  const relative = doc.path.replace(/\/{2,}/g, "/").replace(/^\//, "");
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
  next.search = doc.search ?? "";
  return { url: next.toString(), version: `v1:${doc.version || serve.version}` };
}

export class Documents {
  constructor(
    private readonly client: DedicaClient,
    private readonly circuit: CircuitBreaker,
  ) {}

  /** Dedica's document as the site's response, or null and the origin answers. Throws when the call fails. */
  async get(doc: DocRequest, serve: Policy["serve"], env: Env, request: Request): Promise<Response | null> {
    if (!serve) return null;
    this.circuit.guard(serve.baseUrl);
    if (this.circuit.open) return null;
    const target = serveTarget(serve, doc);
    if (!target) return null;

    const timeoutMs = doc.timeoutMs ?? SERVE_TIMEOUT_MS;
    const circuit = this.circuit.signal;
    // A call released by another's failure doesn't count as a failure of its own.
    const fail = (error: unknown): never => {
      if (!circuit.aborted) this.circuit.trip();
      throw error;
    };
    const headers = { ...requestHeaders(request, doc.shared), [VERSION_HEADER]: target.version, [CATEGORY_HEADER]: doc.category };
    const upstream = await this.client.document(env, target.url, headers, timeoutMs, circuit).catch(fail);

    // Dedica declines this one: the origin answers, and nothing is wrong (no backoff).
    if (upstream.headers.get(CONTENT_FALLBACK_HEADER) === "origin") {
      await upstream.body?.cancel().catch(() => {});
      return null;
    }
    if (upstream.status !== 200 && upstream.status !== 428 && upstream.status !== 304) {
      // 404: Dedica has nothing here (normal). Auth and server errors back off for a while.
      if (upstream.status === 401 || upstream.status === 403 || upstream.status >= 500) {
        this.circuit.trip();
        console.warn(`[dedica] serve response ${upstream.status}; using origin`);
      }
      await upstream.body?.cancel().catch(() => {});
      return null;
    }
    // A 304 only makes sense for validators the visitor sent, which are only forwarded when shared.
    if (upstream.status === 304 && !doc.shared) return null;

    const deadline = AbortSignal.any([AbortSignal.timeout(Math.min(timeoutMs, SERVE_BODY_DEADLINE_MS)), circuit]);
    const body = upstream.status === 304 || request.method === "HEAD" ? null : await readServingBody(upstream, deadline).catch(fail);
    return new Response(body, { status: upstream.status, headers: responseHeaders(upstream, doc.contentType, doc.shared) });
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

/** Reads a served body, refusing anything over 8 MB or slower than `signal` allows. */
async function readServingBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > MAX_SERVED_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("dedica document exceeds serving limit");
  }
  if (!response.body) return new Uint8Array(0);
  return readCapped(response.body, MAX_SERVED_BYTES, signal);
}
