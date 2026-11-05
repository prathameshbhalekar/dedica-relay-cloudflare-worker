/**
 * Recognising agents (ported from ref.js). The lists come from Dedica's policy, so recognition
 * improves without redeploying the worker.
 *
 * - Search engines, link previews and monitors (`traditionalBots`) always get the normal page:
 *   serving them something else could hurt the site's ranking or previews.
 * - A person in a browser always gets the normal page.
 * - Known AI agents, signed agents and automated-looking clients may get Dedica's agent version.
 */

import { ORIGIN_FETCH_HEADER } from "./env";
import type { Detection, Policy, Twins } from "./types";

interface Needle {
  n: string;
  traditional: boolean;
}

let indexed: Needle[] = [];
let indexedFor: Detection | null = null;

/** All needles, longest first, so the most specific wins (`applebot-extended` is AI, `applebot` search). */
function needles(d: Detection): Needle[] {
  if (indexedFor === d) return indexed;
  indexed = [
    ...d.traditionalBots.map((n) => ({ n, traditional: true })),
    ...d.agentUa.map((n) => ({ n, traditional: false })),
  ].sort((a, b) => b.n.length - a.n.length);
  indexedFor = d;
  return indexed;
}

/** Longer user agents are cut before any matching, so a policy pattern never runs over an attacker-sized string. */
export const UA_MATCH_MAX = 512;

export function userAgent(headers: Headers): string {
  return (headers.get("user-agent") ?? "").slice(0, UA_MATCH_MAX).toLowerCase();
}

/** The longest user-agent needle in the user agent, if any. */
function longestNeedle(ua: string, d: Detection): Needle | undefined {
  return needles(d).find((x) => ua.includes(x.n));
}

export function isTraditionalBot(ua: string, d: Detection): boolean {
  if (!ua) return false;
  return (d.traditionalBotsExact ?? []).includes(ua) || Boolean(longestNeedle(ua, d)?.traditional);
}

/** A person opening a page in a browser. */
export function isBrowserNavigation(headers: Headers): boolean {
  return headers.get("sec-fetch-mode") === "navigate" && headers.get("sec-fetch-dest") === "document";
}

const regexCache = new Map<string, RegExp | null>();
function compiled(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  if (!regexCache.has(pattern)) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = null;
    }
    if (regexCache.size > 16) regexCache.clear();
    regexCache.set(pattern, re);
  }
  return regexCache.get(pattern) ?? null;
}

/**
 * Why a client looks automated, in order of precedence: an exact search-engine match, an exact agent match, the
 * longest user-agent needle (`traditional` or `agent`), a known signing domain (`signed`), then an automated-looking
 * user agent without fetch metadata (`botlike`). `matched` is the needle or signing domain that decided it.
 */
interface Classification {
  reason: "traditional" | "agent" | "signed" | "botlike" | null;
  matched: string | null;
  signatureAgent: string | null;
}

function classify(headers: Headers, d: Detection): Classification {
  const ua = userAgent(headers);
  const signed = headers.get("signature-agent")?.toLowerCase();
  const signatureAgent = signed ? (d.signatureAgentDomains.find((x) => signed.includes(x)) ?? null) : null;

  if (ua) {
    if ((d.traditionalBotsExact ?? []).includes(ua)) return { reason: "traditional", matched: ua, signatureAgent };
    if ((d.agentUaExact ?? []).includes(ua)) return { reason: "agent", matched: ua, signatureAgent };
    const hit = longestNeedle(ua, d);
    if (hit) return { reason: hit.traditional ? "traditional" : "agent", matched: hit.n, signatureAgent };
  }
  if (signatureAgent) return { reason: "signed", matched: signatureAgent, signatureAgent };
  if (ua && !headers.has("sec-fetch-mode") && compiled(d.botLikePattern)?.test(ua)) {
    return { reason: "botlike", matched: null, signatureAgent: null };
  }
  return { reason: null, matched: null, signatureAgent: null };
}

/** Whether Dedica's agent version may be served: never to a search engine; a known agent navigating in a browser
 *  only if it also signs its requests. */
export function detectAgent(headers: Headers, d: Detection): boolean {
  const c = classify(headers, d);
  if (c.reason === "agent") return !isBrowserNavigation(headers) || c.signatureAgent !== null;
  return c.reason === "signed" || c.reason === "botlike";
}

/** Who a client is, for traffic reporting: `ai_agent`, `bot` (search engine, preview, monitor, unknown crawler) or
 *  `unknown` (most likely a person). `matched` is the user-agent needle or signing domain that decided it. */
export interface ClientMatch {
  kind: "ai_agent" | "bot" | "unknown";
  matched: string | null;
  signatureAgent: string | null;
}

export function clientMatch(headers: Headers, d: Detection): ClientMatch {
  const { reason, matched, signatureAgent } = classify(headers, d);
  const kind = reason === "agent" || reason === "signed" ? "ai_agent" : reason ? "bot" : "unknown";
  return { kind, matched, signatureAgent };
}

/** Whether this client keeps the person's page even at a `.md` URL (search engines, previews, unknown bots). */
export function keepHumanPage(ua: string, d: Detection, asksQuestion: boolean): boolean {
  const veto = d.humanPageVeto;
  if (!veto) return false;
  const action = veto.exact.find(([needle]) => ua === needle)?.[1] ?? veto.contains.find(([needle]) => ua.includes(needle))?.[1];
  if (action === "human") return true;
  if (action === "agent") return false;
  return !asksQuestion && (action === "question" || Boolean(ua && compiled(veto.botLikePattern)?.test(ua)));
}

/** The policy's include/exclude paths for agent versions of pages (by path prefix). */
export function twinEligible(pathname: string, twins: Twins): boolean {
  const matches = (p: string) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`);
  if ((twins.excludePaths ?? []).some(matches)) return false;
  const include = twins.includePaths ?? [];
  return include.length === 0 || include.some(matches);
}

/** Paths Dedica may manage: on a cold isolate these wait for the policy instead of passing through. */
export function mightBeArtifact(pathname: string): boolean {
  return (
    pathname === "/robots.txt" ||
    pathname === "/llms.txt" ||
    pathname === "/llms-full.txt" ||
    pathname === "/agents.md" ||
    pathname === "/openapi.json" ||
    pathname === "/mcp/server-card" ||
    pathname.endsWith("/llms.txt") ||
    pathname.startsWith("/.well-known/") ||
    pathname.endsWith(".md")
  );
}

const ASSET_RE = /\.(?:js|mjs|css|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|eot|map|webp|avif|mp4|webm|mp3|wav|pdf)$/i;

/** Headers that mark an API call, a session, a partial download or a protocol switch: never a page read. */
const NOT_A_PAGE_HEADERS = ["authorization", "cookie", "upgrade", "range", "x-requested-with"];
const PAGE_DESTS = new Set(["document", "iframe", "frame"]);

/**
 * Whether a request at a normal URL may get Dedica's agent version at all. Anything that looks like an API call or
 * a page's sub-request always gets the origin's answer, without asking Dedica: a static file, a request carrying
 * credentials, a cookie, a range or an upgrade, a browser's non-page fetch, or an `Accept` that asks for JSON
 * rather than a page.
 */
export function negotiable(request: Request, pathname: string): boolean {
  const h = request.headers;
  if (ASSET_RE.test(pathname)) return false;
  if (NOT_A_PAGE_HEADERS.some((name) => h.has(name))) return false;
  const dest = h.get("sec-fetch-dest");
  if (dest !== null && !PAGE_DESTS.has(dest)) return false;
  const accept = (h.get("accept") ?? "").toLowerCase();
  if (accept.includes("json") && !accept.includes("text/html") && !accept.includes("text/markdown")) return false;
  return true;
}

/** Only traffic Dedica may answer waits for a missing policy; everything else passes straight through. */
export function needsPolicy(request: Request, pathname: string, policy: Policy | null): boolean {
  if (request.headers.get(ORIGIN_FETCH_HEADER) === "1") return false;
  if (mightBeArtifact(pathname)) return true;
  if (!negotiable(request, pathname)) return false;
  if (isBrowserNavigation(request.headers)) return false;
  if ((request.headers.get("accept") ?? "").includes("text/markdown")) return true;
  if (policy) return detectAgent(request.headers, policy.detection);
  const ua = userAgent(request.headers);
  return /bot|crawler|chatgpt|claude|perplexity/i.test(ua) || request.headers.has("signature-agent");
}
