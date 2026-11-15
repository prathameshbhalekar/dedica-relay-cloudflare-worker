/**
 * Agent Access: which requests this site's rules answer 403, and which paths it hands back to the origin. Only in
 * `autopilot`, and only while the policy says the rules are enforced. In order:
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
 * Artifacts (`/robots.txt`) are answered before this, so a blocked crawler can still read the file that tells it so.
 * The same rules guard the paths proxied to Dedica (`/ask`, `/mcp`), where a blocked bot gets a JSON 403.
 */

import type { Identity } from "../identity/verdict";
import type { Policy, RouteRule } from "../policy/types";
import { detectAgent, isTraditionalBot } from "../request/classify";
import { isBrowserNavigation } from "../request/facts";
import { normalRoutePath } from "../util/paths";

export type BlockRule = "impersonator" | "serve_human" | "crawler" | "route";

function matches(ua: string, contains: string[], exact: string[]): boolean {
  return ua !== "" && (exact.includes(ua) || contains.some((needle) => ua.includes(needle)));
}

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
  const a = p.access;
  if (!a?.enforce || p.mode !== "autopilot" || a.routes.length === 0) return null;
  const suffix = p.twins.suffix;
  const page = pathname.endsWith(suffix) ? pathname.slice(0, -suffix.length) || "/" : null;
  return routeFor(a.routes, pathname) ?? (page !== null ? routeFor(a.routes, page) : null);
}

/** The rule that blocks this request, or null. `identity` is only awaited when a rule needs it. */
export async function accessBlock(
  headers: Headers,
  ua: string,
  pathname: string,
  p: Policy,
  identity: () => Promise<Identity | null>,
): Promise<BlockRule | null> {
  const a = p.access;
  if (!a?.enforce || p.mode !== "autopilot") return null;

  if (a.impersonators === "block" && a.verification && (await identity())?.tier === "impersonator") return "impersonator";
  if (matches(ua, a.blockedServeHumanUa, a.blockedServeHumanUaExact)) return "serve_human";
  const traditional = isTraditionalBot(ua, p.detection);
  if (!traditional && !isBrowserNavigation(headers) && matches(ua, a.blockedAgentUa, a.blockedAgentUaExact)) return "crawler";
  if (a.blockedAgentKeys.length > 0 && headers.has("signature-agent")) {
    const who = await identity();
    if (who?.signed && who.agent && a.blockedAgentKeys.includes(who.agent)) return "crawler";
  }
  if (routeForRequest(p, pathname)?.action === "block" && !traditional && detectAgent(headers, p.detection)) return "route";
  return null;
}
