/** All per-isolate state and request handling of the worker (see index.ts for what it does). */

import {
  HEARTBEAT_TIMEOUT_MS,
  MIDDLEWARE,
  NEGOTIATE_TIMEOUT_MS,
  ORIGIN_FETCH_HEADER,
  STATUS_PATH,
  VERSION,
  WELL_KNOWN_PATH,
  configured,
  dedicaInit,
  dedicaUrl,
  disabled,
} from "./env";
import { Reporter, type Trace, buildEvent, isReportable } from "./analytics";
import { detectAgent, isTraditionalBot, keepHumanPage, needsPolicy, negotiable, twinEligible, userAgent } from "./detect";
import { type FetchFn, PolicyStore } from "./policy";
import { proxyRequest } from "./proxy";
import { Server } from "./serve";
import type { Artifact, Ctx, Env, Policy } from "./types";

const TEXT = "text/plain; charset=utf-8";

export interface EdgeOptions {
  /** Calls to Dedica (and nothing else). */
  dedicaFetch?: FetchFn;
  /** Calls to the customer's origin. */
  originFetch?: (request: Request) => Promise<Response>;
  now?: () => number;
  /** Waits before a traffic batch is sent (tests pass one that doesn't wait). */
  sleep?: (ms: number) => Promise<void>;
}

/** What the worker needs to know about a request, worked out once. */
interface Visit {
  request: Request;
  url: URL;
  /** Lowercased user agent. */
  ua: string;
  /** `Accept: text/markdown`. */
  acceptsMarkdown: boolean;
}

/** How a request was answered. `response` is null only for `human_page`: the origin still has to answer. */
interface Served extends Trace {
  response: Response | null;
}

/** Dedica's response as a served answer, or null when Dedica had none (and the origin answers). */
function served(outcome: Trace["outcome"], category: Trace["category"], response: Response | null): Served | null {
  return response && { response, outcome, category };
}

/** All per-isolate state of the worker. Tests build their own; the deployed worker uses one. */
export class Edge {
  readonly policies: PolicyStore;
  private readonly server: Server;
  private readonly dedicaFetch: FetchFn;
  private readonly originFetch: (request: Request) => Promise<Response>;
  private readonly now: () => number;
  readonly reporter: Reporter;

  constructor(options: EdgeOptions = {}) {
    this.dedicaFetch = options.dedicaFetch ?? ((input, init) => fetch(input, init));
    this.originFetch = options.originFetch ?? ((request) => fetch(request));
    this.now = options.now ?? Date.now;
    this.policies = new PolicyStore(this.dedicaFetch, this.now);
    this.server = new Server(this.dedicaFetch, this.now);
    this.reporter = new Reporter(this.dedicaFetch, options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))));
  }

  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    // If this worker ever throws, Cloudflare sends the request to the origin instead of an error page.
    ctx.passThroughOnException?.();
    const url = new URL(request.url);

    // Read-only configuration check: no secrets, no calls to Dedica. Answers even when disabled, to show it.
    if (request.method === "GET" && url.pathname === STATUS_PATH) {
      return Response.json(
        {
          configured: configured(env),
          disabled: disabled(env),
          siteId: env.DEDICA_SITE_ID || null,
          mode: this.policies.policy?.mode ?? null,
          version: VERSION,
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    // Kill switch: everything goes to the origin untouched, unreported, with no call to Dedica.
    if (disabled(env)) return this.originFetch(request);

    if (request.method === "GET" && url.pathname === WELL_KNOWN_PATH) {
      return Response.json(
        { site_id: env.DEDICA_SITE_ID ?? null, middleware: MIDDLEWARE, version: VERSION },
        { headers: { "cache-control": "no-store" } },
      );
    }
    // Not set up yet, or Dedica's own crawler reading the origin's page: pass straight through, unreported.
    if (!configured(env) || request.headers.get(ORIGIN_FETCH_HEADER) === "1") return this.originFetch(request);

    const startedAt = this.now();
    const visit: Visit = {
      request,
      url,
      ua: userAgent(request.headers),
      acceptsMarkdown: (request.headers.get("accept") ?? "").includes("text/markdown"),
    };
    const answer = await this.answer(visit, env, ctx);
    this.report(visit, answer, env, ctx, startedAt);
    return answer.response;
  }

  /** Dedica's answer, else the origin's, returned untouched. */
  private async answer(visit: Visit, env: Env, ctx: Ctx): Promise<Served & { response: Response }> {
    const fromDedica = await this.serve(visit, env, ctx).catch((error: unknown) => {
      console.warn(`[dedica] serving failed; using origin: ${error}`);
      return null;
    });
    if (fromDedica?.response) return { ...fromDedica, response: fromDedica.response };

    const response = await this.originFetch(visit.request);
    return { response, outcome: fromDedica?.outcome === "human_page" ? "human_page" : "origin", category: null };
  }

  /** Reports the request to Dedica in the background, batched (see analytics.ts). Never throws. */
  private report(visit: Visit, answer: Served & { response: Response }, env: Env, ctx: Ctx, startedAt: number): void {
    try {
      if (!isReportable(visit.url, visit.request.headers)) return;
      ctx.waitUntil(
        buildEvent(visit.request, answer.response, answer, this.policies.policy, env, startedAt, this.now())
          .then((event) => this.reporter.add(event, env, ctx))
          .catch((error: unknown) => console.warn(`[dedica] event report skipped: ${error}`)),
      );
    } catch (error) {
      console.warn(`[dedica] event report skipped: ${error}`);
    }
  }

  /** What Dedica answers for this request, in order, or null and the origin answers. */
  private async serve(visit: Visit, env: Env, ctx: Ctx): Promise<Served | null> {
    const { request, url, ua } = visit;

    // 1. Paths the policy proxies to Dedica (`/ask`, `/mcp`, ...), any method; independent of agent detection.
    const proxied = await proxyRequest(request, url, await this.policies.get(env, ctx, false), env, this.dedicaFetch);
    if (proxied) return { response: proxied, outcome: "proxied", category: null };
    if (request.method !== "GET" && request.method !== "HEAD") return null;

    const p = await this.policies.get(env, ctx, needsPolicy(request, url.pathname, this.policies.policy));
    if (!p || p.mode !== "autopilot") return null;

    // 2. A file Dedica manages (llms.txt, ...), for every visitor.
    const artifact = p.artifacts.find((a) => a.path === url.pathname);
    if (artifact) return this.artifact(p, env, artifact, request);

    const questionParams = p.twins.questionParams ?? [];
    const asksQuestion =
      questionParams.some((key) => Boolean(url.searchParams.get(key)?.trim())) || (questionParams.length > 0 && /~~.+/.test(url.pathname));

    // 3. Search engines, link previews and (unknown) crawlers keep the person's page, unless they ask a question.
    if (keepHumanPage(ua, p.detection, asksQuestion)) return { response: null, outcome: "human_page", category: null };

    // 4. An explicit markdown request (`/pricing.md`), for anyone who asks. A declared question makes the answer
    //    personal, so it is never shared-cached.
    if (p.twins.enabled && url.pathname.endsWith(p.twins.suffix)) {
      const page = url.pathname.slice(0, -p.twins.suffix.length) || "/";
      if (!twinEligible(page, p.twins)) return null;
      const shared = !questionParams.some((key) => url.searchParams.has(key));
      const input = { path: url.pathname, search: url.search, category: "public" } as const;
      return served("twin", "public", await this.server.fromDedica(p, env, input, TEXT, shared, request));
    }

    // 5. The agent version of a page, for a detected agent or a client asking for `text/markdown`.
    //    Never for a search engine, an API call or a page's sub-request (see `negotiable`), and never a long wait:
    //    the client asked for the origin's page. If Dedica has none for the page, the origin answers.
    if (!p.twins.negotiate || !negotiable(request, url.pathname)) return null;
    const wantsAgentVersion = visit.acceptsMarkdown || detectAgent(request.headers, p.detection);
    if (!isTraditionalBot(ua, p.detection) && twinEligible(url.pathname, p.twins) && wantsAgentVersion) {
      const input = { path: url.pathname, search: url.search, category: "eligible", timeoutMs: NEGOTIATE_TIMEOUT_MS } as const;
      return served("negotiated", "eligible", await this.server.fromDedica(p, env, input, TEXT, false, request));
    }
    return null;
  }

  private async artifact(p: Policy, env: Env, artifact: Artifact, request: Request): Promise<Served | null> {
    switch (artifact.action ?? "proxy") {
      case "proxy":
        return served("artifact", "public", await this.artifactFromDedica(p, env, artifact, request));
      case "fallback":
        return this.fallback(p, env, artifact, request);
      case "block":
        return { response: new Response("Not available to this client.", { status: 403 }), outcome: "blocked", category: "public" };
      default:
        return null;
    }
  }

  /** The origin's own file when it has one, else Dedica's, else the origin's answer after all. */
  private async fallback(p: Policy, env: Env, artifact: Artifact, request: Request): Promise<Served> {
    const origin = await this.originFetch(request).catch(() => null);
    if (!(origin && originHasFile(origin))) {
      const fromDedica = await this.artifactFromDedica(p, env, artifact, request).catch((error: unknown) => {
        console.warn(`[dedica] serving failed; using origin: ${error}`);
        return null;
      });
      if (fromDedica) {
        void origin?.body?.cancel().catch(() => {});
        return { response: fromDedica, outcome: "artifact", category: "public" };
      }
    }
    return { response: origin ?? (await this.originFetch(request)), outcome: "artifact_origin", category: "public" };
  }

  private artifactFromDedica(p: Policy, env: Env, artifact: Artifact, request: Request): Promise<Response | null> {
    const input = { path: artifact.path, version: artifact.version, category: "public" } as const;
    return this.server.fromDedica(p, env, input, artifact.contentType, true, request);
  }

  async heartbeat(env: Env): Promise<void> {
    if (disabled(env)) {
      console.warn("[dedica] heartbeat skipped: DEDICA_DISABLED is set");
      return;
    }
    if (!configured(env)) {
      console.warn("[dedica] heartbeat skipped: DEDICA_SITE_ID, DEDICA_API_URL or DEDICA_MIDDLEWARE_TOKEN is not set");
      return;
    }
    try {
      const response = await this.dedicaFetch(
        dedicaUrl(env, "heartbeat"),
        dedicaInit(env, HEARTBEAT_TIMEOUT_MS, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ middleware: MIDDLEWARE, version: VERSION }),
        }),
      );
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
