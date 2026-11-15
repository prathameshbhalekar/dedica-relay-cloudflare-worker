/**
 * What the worker does with a request, decided before anything is fetched. The steps run in the order SPEC.md
 * section 6 gives them (the letters below are its step letters); the first that decides ends it. Nothing here calls
 * Dedica or the origin: the only thing awaited is the client's identity, worked out lazily when a rule needs it.
 */

import { proxyRoute, proxyTarget } from "../dedica/proxy";
import type { DocRequest } from "../dedica/serve";
import type { Policy } from "../policy/compile";
import type { FileDoc } from "../policy/schema";
import { NEGOTIATE_TIMEOUT_MS, TEXT } from "../protocol";
import type { RequestContext } from "../request/context";
import { eligible, markdownPage } from "../util/paths";
import { accessBlock, routeForRequest } from "./access";
import { type Decision, ORIGIN, ORIGIN_UNREPORTED } from "./decision";

export async function decide(ctx: RequestContext): Promise<Decision> {
  const { facts, policy: p, env } = ctx;
  const { request, url } = facts;

  // 5. Dedica's own crawler reading the origin's page: never Dedica's content, and unreported. The header proves
  //    nothing (anyone can send it), so it never skips Agent Access: a blocked bot sending it is still blocked.
  if (facts.originFetch) {
    const rule = facts.read && p ? await accessBlock(ctx, p) : null;
    return rule ? { do: "block", rule, json: false } : ORIGIN_UNREPORTED;
  }

  // a. No policy, or not in autopilot (no `content`): the origin answers everything.
  const content = p?.content;
  if (!p || !content) return ORIGIN;

  // b. Paths the policy proxies to Dedica (`/ask`, `/mcp`, ...), any method; independent of agent detection. A bot
  //    the site's Agent Access rules block gets a JSON 403 before anything reaches Dedica, and a `passthrough` route
  //    leaves the path to the origin (the site's own `/mcp`, say).
  const proxied = proxyRoute(url, request.method, content);
  if (proxied) {
    const rule = await accessBlock(ctx, p);
    if (rule) return { do: "block", rule, json: true };
    if (routeForRequest(p, url.pathname)?.action === "passthrough") return ORIGIN;
    const target = proxyTarget(proxied, url, env);
    if (target) return { do: "proxy", target };
  }

  // c. Only GET and HEAD get anything else from Dedica.
  if (!facts.read) return ORIGIN;

  // e. A file Dedica manages (llms.txt, robots.txt, ...), for every visitor. Before the block rules, so a blocked
  //    crawler can still read the robots.txt that tells it so.
  const file = content.files.find((f) => f.path === url.pathname);
  if (file) return fileDecision(file, p);

  // f. Agent Access: a bot this site blocks, or a route it blocks for agents (see access.ts).
  const rule = await accessBlock(ctx, p);
  if (rule) return { do: "block", rule, json: false };

  // g. A `passthrough` route leaves the path, and its `.md` version, to the origin.
  if (routeForRequest(p, url.pathname)?.action === "passthrough") return ORIGIN;

  const client = ctx.client(p);

  // h. Search engines, link previews and generic crawlers keep the person's page, at any URL.
  if (client.keepsHumanPage) return { do: "origin", outcome: "human_page" };

  // i. An explicit markdown URL (`/pricing.md`), for anyone else who asks. The same for everyone, so shared caches
  //    may keep it.
  const page = markdownPage(url.pathname);
  if (page !== null) {
    if (!eligible(page, content.excludePaths)) return ORIGIN;
    return { do: "serve", doc: doc(url, p, "public"), outcome: "twin" };
  }

  // j. The agent version of a page, for a detected agent or a client asking for `text/markdown`. Never for a search
  //    engine, an API call or a page's sub-request, and never a long wait: the client asked for the origin's page.
  if (
    content.negotiate &&
    facts.pageRead &&
    !client.searchEngine &&
    (facts.acceptsMarkdown || client.wantsAgentVersion) &&
    eligible(url.pathname, content.excludePaths)
  ) {
    return { do: "serve", doc: doc(url, p, "eligible"), outcome: "negotiated" };
  }

  // k.
  return ORIGIN;
}

/** A page's markdown version (`public`, shared) or its agent version at the page URL (`eligible`, private). */
function doc(url: URL, p: Policy, category: DocRequest["category"]): DocRequest {
  const shared = category === "public";
  return {
    path: url.pathname,
    search: url.search,
    version: p.version,
    category,
    contentType: TEXT,
    shared,
    timeoutMs: shared ? undefined : NEGOTIATE_TIMEOUT_MS,
  };
}

function fileDecision(file: FileDoc, p: Policy): Decision {
  const doc: DocRequest = { path: file.path, version: file.version || p.version, category: "public", contentType: file.contentType, shared: true };
  return file.action === "fallback" ? { do: "fallback", doc } : { do: "serve", doc, outcome: "artifact" };
}
