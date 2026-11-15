/**
 * What the worker does with a request, decided before anything is fetched. The steps run in the order SPEC.md
 * section 6 gives them (the letters below are its step letters); the first that decides ends it. Nothing here calls
 * Dedica or the origin: the only thing awaited is the client's identity, worked out lazily when a rule needs it.
 */

import type { DocRequest } from "../dedica/serve";
import { proxyRoute, proxyTarget } from "../dedica/proxy";
import type { Artifact, Policy } from "../policy/types";
import { NEGOTIATE_TIMEOUT_MS, TEXT } from "../protocol";
import { detectAgent, isTraditionalBot, keepHumanPage, twinEligible } from "../request/classify";
import type { RequestContext } from "../request/context";
import { accessBlock, routeForRequest } from "./access";
import { type Decision, ORIGIN, ORIGIN_UNREPORTED } from "./decision";

export async function decide(ctx: RequestContext): Promise<Decision> {
  const { facts, policy: p, env } = ctx;
  const { request, url, ua } = facts;
  const blockRule = (p: Policy) => accessBlock(request.headers, ua, url.pathname, p, () => ctx.identity(p));

  // 5. Dedica's own crawler reading the origin's page: never Dedica's content, and unreported. The header proves
  //    nothing (anyone can send it), so it never skips Agent Access: a blocked bot sending it is still blocked.
  if (facts.originFetch) {
    const rule = facts.read && p ? await blockRule(p) : null;
    return rule ? { do: "block", rule, json: false } : ORIGIN_UNREPORTED;
  }

  // b. Paths the policy proxies to Dedica (`/ask`, `/mcp`, ...), any method; independent of agent detection. A bot
  //    the site's Agent Access rules block gets a JSON 403 before anything reaches Dedica, and a `passthrough` route
  //    leaves the path to the origin (the site's own `/mcp`, say).
  const proxied = p && proxyRoute(url, request.method, p);
  if (p && proxied) {
    const rule = await blockRule(p);
    if (rule) return { do: "block", rule, json: true };
    if (routeForRequest(p, url.pathname)?.action === "passthrough") return ORIGIN;
    const target = proxyTarget(proxied, url, env);
    if (target) return { do: "proxy", target };
  }

  // c, d. Only GET and HEAD, and only in autopilot, get anything from Dedica.
  if (!facts.read || !p || p.mode !== "autopilot") return ORIGIN;

  // e. A file Dedica manages (llms.txt, robots.txt, ...), for every visitor. Before the block rules, so a blocked
  //    crawler can still read the robots.txt that tells it so.
  const artifact = p.artifacts.find((a) => a.path === url.pathname);
  if (artifact) return artifactDecision(artifact);

  // f. Agent Access: a bot this site blocks, or a route it blocks for agents (see access.ts).
  const rule = await blockRule(p);
  if (rule) return { do: "block", rule, json: false };

  // g. A `passthrough` route leaves the path, and its `.md` version, to the origin.
  if (routeForRequest(p, url.pathname)?.action === "passthrough") return ORIGIN;

  const questionParams = p.twins.questionParams ?? [];
  const asksQuestion =
    questionParams.some((key) => Boolean(url.searchParams.get(key)?.trim())) || (questionParams.length > 0 && /~~.+/.test(url.pathname));

  // h. Search engines, link previews and (unknown) crawlers keep the person's page, unless they ask a question.
  if (keepHumanPage(ua, p.detection, asksQuestion)) return { do: "origin", outcome: "human_page" };

  // i. An explicit markdown request (`/pricing.md`), for anyone who asks. A declared question makes the answer
  //    personal, so it is never shared-cached.
  if (p.twins.enabled && url.pathname.endsWith(p.twins.suffix)) {
    const page = url.pathname.slice(0, -p.twins.suffix.length) || "/";
    if (!twinEligible(page, p.twins)) return ORIGIN;
    const shared = !questionParams.some((key) => url.searchParams.has(key));
    const doc: DocRequest = { path: url.pathname, search: url.search, category: "public", contentType: TEXT, shared };
    return { do: "serve", doc, outcome: "twin" };
  }

  // j. The agent version of a page, for a detected agent or a client asking for `text/markdown`. Never for a search
  //    engine, an API call or a page's sub-request, and never a long wait: the client asked for the origin's page.
  if (!p.twins.negotiate || !facts.pageRead) return ORIGIN;
  const wantsAgentVersion = facts.acceptsMarkdown || detectAgent(request.headers, p.detection);
  if (wantsAgentVersion && !isTraditionalBot(ua, p.detection) && twinEligible(url.pathname, p.twins)) {
    const doc: DocRequest = {
      path: url.pathname,
      search: url.search,
      category: "eligible",
      contentType: TEXT,
      shared: false,
      timeoutMs: NEGOTIATE_TIMEOUT_MS,
    };
    return { do: "serve", doc, outcome: "negotiated" };
  }

  // k.
  return ORIGIN;
}

function artifactDecision(artifact: Artifact): Decision {
  const doc: DocRequest = { path: artifact.path, version: artifact.version, category: "public", contentType: artifact.contentType, shared: true };
  switch (artifact.action ?? "proxy") {
    case "proxy":
      return { do: "serve", doc, outcome: "artifact" };
    case "fallback":
      return { do: "fallback", doc };
    case "block":
      return { do: "block", rule: "file", json: false };
    default:
      return ORIGIN;
  }
}
