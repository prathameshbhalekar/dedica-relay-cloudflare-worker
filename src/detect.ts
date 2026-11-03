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

export function userAgent(headers: Headers): string {
  return (headers.get("user-agent") ?? "").toLowerCase();
}

export function isTraditionalBot(ua: string, d: Detection): boolean {
  if (!ua) return false;
  if ((d.traditionalBotsExact ?? []).includes(ua)) return true;
  const hit = needles(d).find((x) => ua.includes(x.n));
  return hit ? hit.traditional : false;
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

export function detectAgent(headers: Headers, d: Detection): boolean {
  const ua = userAgent(headers);

  if (ua) {
    // Exact matches outrank substring needles; a search-engine exact match vetoes first.
    const exactVeto = (d.traditionalBotsExact ?? []).includes(ua);
    const exactAgent = !exactVeto && (d.agentUaExact ?? []).includes(ua);
    const hit = exactVeto ? { traditional: true } : exactAgent ? { traditional: false } : needles(d).find((x) => ua.includes(x.n));
    if (hit) {
      if (hit.traditional) return false;
      if (!isBrowserNavigation(headers)) return true;
    }
  }

  const signed = headers.get("signature-agent")?.toLowerCase();
  if (signed && d.signatureAgentDomains.some((x) => signed.includes(x))) return true;

  const pattern = compiled(d.botLikePattern);
  if (!headers.has("sec-fetch-mode") && ua && pattern?.test(ua)) {
    // Something that looks automated, unless it is a known search engine.
    return !needles(d).some((x) => x.traditional && ua.includes(x.n));
  }
  return false;
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
    pathname.startsWith("/.well-known/") ||
    pathname.endsWith(".md")
  );
}

const ASSET_RE = /\.(?:js|mjs|css|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|eot|map|webp|avif|mp4|webm|mp3|wav|pdf)$/i;

/** Only traffic Dedica may answer waits for a missing policy; everything else passes straight through. */
export function needsPolicy(request: Request, pathname: string, policy: Policy | null): boolean {
  if (request.headers.get(ORIGIN_FETCH_HEADER) === "1") return false;
  if (mightBeArtifact(pathname)) return true;
  if (ASSET_RE.test(pathname)) return false;
  if (isBrowserNavigation(request.headers)) return false;
  if ((request.headers.get("accept") ?? "").includes("text/markdown")) return true;
  if (policy) return detectAgent(request.headers, policy.detection);
  const ua = userAgent(request.headers);
  return /bot|crawler|chatgpt|claude|perplexity/i.test(ua) || request.headers.has("signature-agent");
}
