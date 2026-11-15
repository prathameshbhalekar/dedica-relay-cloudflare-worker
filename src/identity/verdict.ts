/**
 * Who a bot really is (Agent Access), worked out at the edge from data in the policy:
 *
 * - `verified`: a valid Web Bot Auth signature from a signing agent Dedica knows, or a user agent naming a bot whose
 *   request comes from that bot's published IP ranges.
 * - `impersonator`: a user agent naming a bot whose vendor publishes ranges, from outside all of them.
 * - `claimed`: a user agent naming a bot, with nothing to check it against (no published ranges, ranges too old, or
 *   no client IP). Never treated as suspicious.
 * - `unknown`: an automated client that names no bot Dedica knows.
 *
 * The client IP (`cf-connecting-ip`, set by Cloudflare and not forgeable by the client) is used here only, in memory.
 * It is never reported: events carry only the verdict.
 */

import type { Verification } from "../policy/types";
import { fresh } from "./fresh";
import { compiledRanges, inRanges, parseIp } from "./ip";
import { verifiedSigner } from "./signature";

export type Tier = "verified" | "claimed" | "impersonator" | "unknown";

export interface Identity {
  tier: Tier;
  /** The catalog key of the agent named or proven, if any. */
  agent: string | null;
  /** Proven by a signature (as opposed to an IP range). */
  signed: boolean;
}

const exactIndex = new WeakMap<Verification, Map<string, string>>();

/** The catalog key of the bot a (lowercased) user agent names, or null. */
export function claimedAgent(v: Verification, ua: string): string | null {
  if (!ua) return null;
  let exact = exactIndex.get(v);
  if (!exact) {
    exact = new Map(v.claimsExact);
    exactIndex.set(v, exact);
  }
  return exact.get(ua) ?? v.claims.find(([needle]) => ua.includes(needle))?.[1] ?? null;
}

/** `verified` or `impersonator` from the client IP, or `claimed` when there is nothing fresh to check against. */
export function ipTier(v: Verification, agent: string, clientIp: string | null, now: number): Tier {
  const sets = (v.agentIpSets[agent] ?? []).map((id) => v.ipSets[id]).filter((s) => s !== undefined && fresh(s.fetchedAt, v, now));
  const ip = clientIp ? parseIp(clientIp) : null;
  if (sets.length === 0 || !ip) return "claimed";
  return sets.some((s) => inRanges(ip, compiledRanges(s))) ? "verified" : "impersonator";
}

/**
 * Who sent this request. `ua` is lowercased; `automated` says whether the worker already took it for a bot (so an
 * unnamed one is `unknown` rather than a person). Null for a person, or when the policy carries no verification data.
 */
export async function identify(
  v: Verification | null,
  request: Request,
  ua: string,
  automated: boolean,
  now: number,
): Promise<Identity | null> {
  if (!v) return null;
  const claimed = claimedAgent(v, ua);
  const signer = await verifiedSigner(v, request, now).catch(() => null);
  if (signer) {
    const agent = claimed && signer.agents.includes(claimed) ? claimed : (signer.agents[0] ?? null);
    return { tier: "verified", agent, signed: true };
  }
  if (claimed) return { tier: ipTier(v, claimed, request.headers.get("cf-connecting-ip"), now), agent: claimed, signed: false };
  return automated ? { tier: "unknown", agent: null, signed: false } : null;
}
