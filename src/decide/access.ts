/**
 * Agent Access: which requests this site's rules answer 403, and which paths it hands back to the origin. Only
 * while the policy carries an `access` section (rules enforced, autopilot). In order:
 *
 * 1. An impersonator (a user agent naming a bot, from outside that bot's published IP ranges), when the site blocks
 *    them. Before the search-engine exemption below: a fake Googlebot is exactly the request it must not protect.
 * 2. A search engine, link preview or monitor the site blocked by name. No browser exemption: a person's browser
 *    never calls itself Googlebot.
 * 3. A blocked AI agent or tool, by user agent: never a search engine (a needle overlap can't 403 Googlebot), never a
 *    person opening a page in a browser.
 * 4. A blocked agent proven by its signature, whatever its user agent says.
 * 5. A route rule for the path (or, for `/x.md`, the page `/x`): `block` answers a detected AI agent 403 (never a
 *    search engine or a person); `passthrough` hands the path to the origin untouched, with no agent version.
 *
 * Nothing is exempt by user agent or header: a request can't talk its way past these rules. Dedica's own clients
 * are never on a block list (Dedica doesn't let a site block them), and its crawler identifies as a monitor.
 * Files (`/robots.txt`) are answered before this, so a blocked crawler can still read the file that tells it so.
 * The same rules guard the paths proxied to Dedica (`/ask`, `/mcp`), where a blocked bot gets a JSON 403.
 */

import type { Policy } from "../policy/compile";
import type { RouteRule } from "../policy/schema";
import type { RequestContext } from "../request/context";
import { match } from "../util/match";
import { markdownPage, normalRoutePath } from "../util/paths";

export type BlockRule = "impersonator" | "serve_human" | "crawler" | "route";

/** The rule for a path: an exact match beats any prefix, and a longer prefix beats a shorter one. */
export function routeFor(routes: RouteRule[], pathname: string): RouteRule | null {
  const path = normalRoutePath(pathname);
  let best: RouteRule | null = null;
  let bestLength = -1;
  let bestExact = false;
  for (const rule of routes) {
    const rulePath = normalRoutePath(rule.path);
    const exact = rule.kind === "exact";
    const hit = exact ? path === rulePath : rulePath === "/" || path === rulePath || path.startsWith(`${rulePath}/`);
    if (!hit) continue;
    if ((exact && !bestExact) || (exact === bestExact && rulePath.length > bestLength)) {
      best = rule;
      bestLength = rulePath.length;
      bestExact = exact;
    }
  }
  return best;
}

/** The route rule for this request: its own path first, then (for `/pricing.md`) the page it is the version of. */
export function routeForRequest(p: Policy, pathname: string): RouteRule | null {
  const routes = p.access?.routes ?? [];
  if (routes.length === 0) return null;
  const page = markdownPage(pathname);
  return routeFor(routes, pathname) ?? (page !== null ? routeFor(routes, page) : null);
}

/** The rule that blocks this request, or null. The client's identity is only worked out when a rule needs it. */
export async function accessBlock(ctx: RequestContext, p: Policy): Promise<BlockRule | null> {
  const a = p.access;
  if (!a) return null;
  const { ua, browserNavigation, request, url } = ctx.facts;
  const client = ctx.client(p);

  if (a.impersonators === "block" && p.verification && (await ctx.identity(p))?.tier === "impersonator") return "impersonator";
  if (match(a.blockedSearch, ua)) return "serve_human";
  if (!client.searchEngine && !browserNavigation && match(a.blockedOther, ua)) return "crawler";
  if (a.blocked.size > 0 && request.headers.has("signature-agent")) {
    const who = await ctx.identity(p);
    if (who?.signed && who.agent && a.blocked.has(who.agent)) return "crawler";
  }
  if (routeForRequest(p, url.pathname)?.action === "block" && !client.searchEngine && client.wantsAgentVersion) return "route";
  return null;
}
