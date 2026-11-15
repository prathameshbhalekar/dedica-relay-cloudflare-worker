/**
 * Recognising clients, once per request, from the policy's agent catalog (so recognition improves without
 * redeploying the worker).
 *
 * - Search engines, link previews and monitors always get the normal page at a normal URL: serving them something
 *   else could hurt the site's ranking or previews.
 * - A person in a browser always gets the normal page.
 * - Known AI agents, signed agents and automated-looking clients may get Dedica's agent version.
 */

import type { Agent, Policy } from "../policy/compile";
import { match } from "../util/match";
import type { RequestFacts } from "./facts";

/**
 * Why a client looks automated, in order of precedence: what its user agent names (`search` or `agent`: a whole user
 * agent first, then the longest needle), a known signing host (`signed`), then an automated-looking user agent
 * without fetch metadata (`botlike`).
 */
export type Reason = "search" | "agent" | "signed" | "botlike";

export interface Client {
  reason: Reason | null;
  /** The catalog entry the user agent names (tools aside). */
  agent: Agent | null;
  /** The needle or signing host that decided it. */
  matched: string | null;
  /** The recognised `Signature-Agent` host, whatever decided it. Not proof: identity/ checks the signature. */
  signer: string | null;
  /** A search engine, link preview or monitor: never gets the agent version at a normal URL. */
  searchEngine: boolean;
  /** May get Dedica's agent version: never a search engine; a known agent in a browser only if it signs. */
  wantsAgentVersion: boolean;
  /** Keeps the person's page, at any URL (even `.md`): search engines, previews, generic crawlers. */
  keepsHumanPage: boolean;
}

export function classify(facts: RequestFacts, p: Policy): Client {
  const { ua } = facts;
  const headers = facts.request.headers;
  const signed = headers.get("signature-agent")?.toLowerCase();
  const signer = signed ? (p.signerHosts.find((host) => signed.includes(host)) ?? null) : null;
  const named = match(p.detect, ua);

  let reason: Reason | null = null;
  let matched: string | null = null;
  if (named) {
    reason = named.value.kind === "search" ? "search" : "agent";
    matched = named.needle;
  } else if (signer) {
    reason = "signed";
    matched = signer;
  } else if (ua && !headers.has("sec-fetch-mode") && p.botLike.test(ua)) {
    reason = "botlike";
  }

  const wantsAgentVersion = reason === "agent" ? !facts.browserNavigation || signer !== null : reason === "signed" || reason === "botlike";
  // At a `.md` URL: what the catalog says for a named client; an unnamed one keeps the person's page if it looks
  // like a generic crawler.
  const keepsHumanPage = named ? named.value.page === "human" : Boolean(ua) && p.crawler.test(ua);
  return { reason, agent: named?.value ?? null, matched, signer, searchEngine: reason === "search", wantsAgentVersion, keepsHumanPage };
}

/** Who a client is, for traffic reporting: `ai_agent`, `bot` (search engine, preview, monitor, automated client) or
 *  `unknown` (most likely a person). */
export function clientKind(c: Client): "ai_agent" | "bot" | "unknown" {
  return c.reason === "agent" || c.reason === "signed" ? "ai_agent" : c.reason ? "bot" : "unknown";
}

