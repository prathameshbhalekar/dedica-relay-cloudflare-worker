/**
 * Recognising agents. The lists come from Dedica's policy, so recognition
 * improves without redeploying the worker.
 *
 * - Search engines, link previews and monitors (`traditionalBots`) always get the normal page:
 *   serving them something else could hurt the site's ranking or previews.
 * - A person in a browser always gets the normal page.
 * - Known AI agents, signed agents and automated-looking clients may get Dedica's agent version.
 */

import type { Detection, Twins } from "../policy/types";
import { underPrefix } from "../util/paths";
import { isBrowserNavigation, userAgent } from "./facts";

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

/** The longest user-agent needle in the user agent, if any. */
function longestNeedle(ua: string, d: Detection): Needle | undefined {
  return needles(d).find((x) => ua.includes(x.n));
}

export function isTraditionalBot(ua: string, d: Detection): boolean {
  if (!ua) return false;
  return (d.traditionalBotsExact ?? []).includes(ua) || Boolean(longestNeedle(ua, d)?.traditional);
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
  const matches = (p: string) => underPrefix(pathname, p);
  if ((twins.excludePaths ?? []).some(matches)) return false;
  const include = twins.includePaths ?? [];
  return include.length === 0 || include.some(matches);
}
