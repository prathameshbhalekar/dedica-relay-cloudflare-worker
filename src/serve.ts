/**
 * Serving from Dedica (ported from ref.js). Fetch a file from Dedica and return it as the site's
 * response, or null and the origin answers. Dedica answers 200, 304 or 428 ("ask a question first");
 * anything else, including Dedica being slow or down, falls back to the origin.
 */

import {
  CATEGORY_HEADER,
  NO_CACHE_CF,
  ORIGIN_FETCH_HEADER,
  SERVED_HEADER,
  SERVE_TIMEOUT_MS,
  TOKEN_HEADER,
  TRANSMITTER,
  TRANSMITTER_HEADER,
  VERSION_HEADER,
} from "./env";
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
}

export class Server {
  private backoffUntil = 0;
  private identity = "";

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly now: () => number = Date.now,
  ) {}

  private failed(): void {
    this.backoffUntil = this.now() + SERVE_BACKOFF_MS;
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
    if (request.headers.get(ORIGIN_FETCH_HEADER) === "1") return null;
    const target = this.target(policy, input);
    if (!target) return null;

    const upstream = await this.fetchFn(target.url, {
      headers: {
        ...requestHeaders(env, request, shared),
        [VERSION_HEADER]: target.version,
        [CATEGORY_HEADER]: input.category ?? "eligible",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(SERVE_TIMEOUT_MS),
      // `cf` is Cloudflare's extension of RequestInit (ignored outside Workers).
      cf: NO_CACHE_CF,
    }).catch((error: unknown) => {
      this.failed();
      throw error;
    });

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

    const headers = responseHeaders(upstream, contentType, shared);
    const body =
      upstream.status === 304 || request.method === "HEAD"
        ? null
        : await readServingBody(upstream).catch((error: unknown) => {
            this.failed();
            throw error;
          });
    return new Response(body, { status: upstream.status, headers });
  }
}

/** Only dedicated representations accept browser validators: a page URL may carry an HTML validator. */
function requestHeaders(env: Env, request: Request, shared: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    [TOKEN_HEADER]: env.DEDICA_MIDDLEWARE_TOKEN ?? "",
    [TRANSMITTER_HEADER]: TRANSMITTER,
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

/** Reads a served body, refusing anything over 8 MB or slower than 10 s. */
export async function readServingBody(response: Response): Promise<ArrayBuffer> {
  if (Number(response.headers.get("content-length")) > MAX_SERVED_BYTES) throw new Error("dedica document exceeds serving limit");
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("dedica document body deadline exceeded"));
      void reader.cancel().catch(() => {});
    }, BODY_DEADLINE_MS);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SERVED_BYTES) throw new Error("dedica document exceeds serving limit");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
    reader.releaseLock();
  }
}
