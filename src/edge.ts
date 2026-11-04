/** All per-isolate state and request handling of the worker (see index.ts for what it does). */

import {
  HEARTBEAT_TIMEOUT_MS,
  MIDDLEWARE,
  ORIGIN_FETCH_HEADER,
  SERVED_HEADER,
  STATUS_PATH,
  TOKEN_HEADER,
  TRANSMITTER,
  TRANSMITTER_HEADER,
  VERSION,
  WELL_KNOWN_PATH,
  configured,
  heartbeatUrl,
} from "./env";
import { detectAgent, isTraditionalBot, keepHumanPage, needsPolicy, twinEligible, userAgent } from "./detect";
import { type FetchFn, PolicyStore } from "./policy";
import { createQueryProxy, isQueryRoute } from "./query";
import { Server } from "./serve";
import type { Artifact, Ctx, Env, Policy } from "./types";

const TEXT = "text/plain; charset=utf-8";
const MARKDOWN = "text/markdown; charset=utf-8";
/** `?mode=agent` asks for the agent version of any page, like `Accept: text/markdown`. */
const AGENT_MODE_PARAM = "mode";

export interface EdgeOptions {
  /** Calls to Dedica (and nothing else). */
  dedicaFetch?: FetchFn;
  /** Calls to the customer's origin. */
  originFetch?: (request: Request) => Promise<Response>;
  now?: () => number;
}

/** All per-isolate state of the worker. Tests build their own; the deployed worker uses one. */
export class Edge {
  readonly policies: PolicyStore;
  private readonly server: Server;
  private readonly dedicaFetch: FetchFn;
  private readonly originFetch: (request: Request) => Promise<Response>;
  private readonly now: () => number;
  private queryProxy: ReturnType<typeof createQueryProxy> | null = null;
  private queryProxyIdentity = "";

  constructor(options: EdgeOptions = {}) {
    this.dedicaFetch = options.dedicaFetch ?? ((input, init) => fetch(input, init));
    this.originFetch = options.originFetch ?? ((request) => fetch(request));
    this.now = options.now ?? Date.now;
    this.policies = new PolicyStore(this.dedicaFetch, this.now);
    this.server = new Server(this.dedicaFetch, this.now);
  }

  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    // If this worker ever throws, Cloudflare sends the request to the origin instead of an error page.
    ctx.passThroughOnException?.();
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === WELL_KNOWN_PATH) {
      return Response.json(
        { site_id: env.DEDICA_SITE_ID ?? null, middleware: MIDDLEWARE, version: VERSION },
        { headers: { "cache-control": "no-store" } },
      );
    }
    // Read-only configuration check: no secrets, no calls to Dedica.
    if (request.method === "GET" && url.pathname === STATUS_PATH) {
      return Response.json(
        { configured: configured(env), siteId: env.DEDICA_SITE_ID || null, mode: this.policies.policy?.mode ?? null, version: VERSION },
        { headers: { "cache-control": "no-store" } },
      );
    }

    const served = await this.serve(request, env, ctx).catch((error: unknown) => {
      console.warn(`[dedica] serving failed; using origin: ${error}`);
      return null;
    });
    if (served) return served;
    const response = await this.originFetch(request);
    try {
      return this.agentNotFound(request, env, response) ?? response;
    } catch {
      return response;
    }
  }

  /** The origin's 404/410, with a markdown body for an agent so it knows where to go next (status kept). */
  private agentNotFound(request: Request, env: Env, response: Response): Response | null {
    if (response.status !== 404 && response.status !== 410) return null;
    if ((request.method !== "GET" && request.method !== "HEAD") || !configured(env)) return null;
    if (request.headers.get(ORIGIN_FETCH_HEADER) === "1") return null;
    const p = this.policies.policy;
    if (!p || p.mode !== "autopilot") return null;
    const ua = userAgent(request.headers);
    const url = new URL(request.url);
    const wantsMarkdown = (request.headers.get("accept") ?? "").includes("text/markdown");
    if (isTraditionalBot(ua, p.detection) || !(wantsMarkdown || detectAgent(request.headers, p.detection))) return null;
    if ((response.headers.get("content-type") ?? "").includes("text/markdown")) return null;

    const lines = [
      "# Not found",
      "",
      `There is no page at \`${url.pathname}\` on ${url.host} (HTTP ${response.status}).`,
      "",
      ...(p.artifacts.some((a) => a.path === "/llms.txt") ? [`- An index of this site's pages for agents: ${url.origin}/llms.txt`] : []),
      `- The home page: ${url.origin}/`,
    ];
    void response.body?.cancel().catch(() => {});
    return new Response(request.method === "HEAD" ? null : `${lines.join("\n")}\n`, {
      status: response.status,
      headers: { "content-type": MARKDOWN, "cache-control": "private, no-store", vary: "accept, user-agent", [SERVED_HEADER]: "1" },
    });
  }

  private queryProxyFor(env: Env) {
    const identity = JSON.stringify([env.DEDICA_SITE_ID, env.DEDICA_MIDDLEWARE_TOKEN, env.DEDICA_API_URL, env.DEDICA_QUERY_ORIGIN]);
    if (!this.queryProxy || this.queryProxyIdentity !== identity) {
      this.queryProxyIdentity = identity;
      this.queryProxy = createQueryProxy(env, {
        fetch: (target, init) => this.dedicaFetch(target, init),
        visitor: (request) => request.headers.get("cf-connecting-ip") ?? "unknown",
        now: this.now,
      });
    }
    return this.queryProxy;
  }

  /** What Dedica answers for this request, in order, or null and the origin answers. */
  async serve(request: Request, env: Env, ctx: Ctx): Promise<Response | null> {
    if (!configured(env)) return null;
    const url = new URL(request.url);
    const originFetch = request.headers.get(ORIGIN_FETCH_HEADER) === "1";

    // 1. /ask and /mcp: explicit capabilities, independent of agent detection.
    if (isQueryRoute(url.pathname)) {
      const query = await this.queryProxyFor(env)(request, (blocking) => this.policies.get(env, ctx, blocking), this.policies.policy);
      if (query) return query;
    }
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    if (originFetch) return null;

    const p = await this.policies.get(env, ctx, needsPolicy(request, url.pathname, this.policies.policy));
    if (!p || p.mode !== "autopilot") return null;

    // 2. A file Dedica manages (llms.txt, ...), for every visitor.
    const artifact = p.artifacts.find((a) => a.path === url.pathname);
    if (artifact) return this.artifact(p, env, artifact, request);

    const ua = userAgent(request.headers);
    const traditional = isTraditionalBot(ua, p.detection);
    const questionParams = p.twins.questionParams ?? [];
    const asksQuestion =
      questionParams.some((key) => Boolean(url.searchParams.get(key)?.trim())) || (questionParams.length > 0 && /~~.+/.test(url.pathname));
    const agentMode = url.searchParams.get(AGENT_MODE_PARAM) === "agent";

    // 3. Search engines, link previews and (unknown) crawlers keep the person's page, unless they ask for agent mode.
    if (keepHumanPage(ua, p.detection, asksQuestion || agentMode)) return null;

    // 4. An explicit markdown request (`/pricing.md`), for anyone who asks.
    if (p.twins.enabled && url.pathname.endsWith(p.twins.suffix)) {
      const page = url.pathname.slice(0, -p.twins.suffix.length) || "/";
      if (!twinEligible(page, p.twins)) return null;
      const asked = varies(url, p);
      return this.server.fromDedica(p, env, { path: url.pathname, search: url.search, category: "public" }, TEXT, !asked, request);
    }

    // 5. The agent version of a page, for a detected agent, a client asking for `text/markdown`, or `?mode=agent`.
    //    Never for a search engine. If Dedica has none for the page, the origin answers.
    const wantsMarkdown = (request.headers.get("accept") ?? "").includes("text/markdown") || agentMode;
    if (p.twins.negotiate && !traditional && twinEligible(url.pathname, p.twins) && (wantsMarkdown || detectAgent(request.headers, p.detection))) {
      return this.server.fromDedica(p, env, { path: url.pathname, search: url.search, category: "eligible" }, TEXT, false, request);
    }
    return null;
  }

  private artifact(p: Policy, env: Env, artifact: Artifact, request: Request): Promise<Response | null> | Response | null {
    switch (artifact.action ?? "proxy") {
      case "proxy":
        return this.server.fromDedica(p, env, { path: artifact.path, version: artifact.version, category: "public" }, artifact.contentType, true, request);
      case "fallback":
        return this.fallback(p, env, artifact, request);
      case "block":
        return new Response("Not available to this client.", { status: 403 });
      default:
        return null;
    }
  }

  /** The origin's own file when it has one, else Dedica's, else the origin's answer after all. */
  private async fallback(p: Policy, env: Env, artifact: Artifact, request: Request): Promise<Response> {
    const origin = await this.originFetch(request).catch(() => null);
    if (origin && originHasFile(origin)) return origin;
    try {
      const served = await this.server.fromDedica(
        p,
        env,
        { path: artifact.path, version: artifact.version, category: "public" },
        artifact.contentType,
        true,
        request,
      );
      if (served) {
        void origin?.body?.cancel().catch(() => {});
        return served;
      }
    } catch (error) {
      console.warn(`[dedica] serving failed; using origin: ${error}`);
    }
    return origin ?? this.originFetch(request);
  }

  async heartbeat(env: Env): Promise<void> {
    if (!configured(env)) {
      console.warn("[dedica] heartbeat skipped: DEDICA_SITE_ID, DEDICA_API_URL or DEDICA_MIDDLEWARE_TOKEN is not set");
      return;
    }
    try {
      const response = await this.dedicaFetch(heartbeatUrl(env), {
        method: "POST",
        headers: { "content-type": "application/json", [TOKEN_HEADER]: env.DEDICA_MIDDLEWARE_TOKEN ?? "", [TRANSMITTER_HEADER]: TRANSMITTER },
        body: JSON.stringify({ middleware: MIDDLEWARE, version: VERSION }),
        signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
      });
      if (!response.ok) console.warn(`[dedica] heartbeat failed: ${response.status}`);
    } catch (err) {
      console.warn(`[dedica] heartbeat request failed: ${err}`);
    }
  }
}

/** A real file at the origin: any redirect, or a 2xx that isn't an HTML page (a single-page app answers every path). */
function originHasFile(response: Response): boolean {
  if (response.status >= 300 && response.status < 400) return true;
  if (response.status < 200 || response.status >= 300) return false;
  return !(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
}

/** Whether the visitor asked a declared question: that answer is never shared-cached. */
function varies(url: URL, p: Policy): boolean {
  return (p.twins.questionParams ?? []).some((k) => url.searchParams.has(k));
}
