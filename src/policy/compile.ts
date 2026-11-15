/**
 * The policy in the form the worker uses on every request, built once when a policy arrives: user-agent indexes,
 * compiled patterns, parsed IP ranges, block lists by rule. Nothing policy-derived is cached anywhere else.
 */

import { type Cidr, parseCidr } from "../identity/ip";
import { type Needles, needles } from "../util/match";
import type { AccessDoc, AgentDoc, ContentDoc, Mode, PolicyDoc, RouteRule, SignatureKey } from "./schema";

export interface Agent {
  key: string;
  kind: AgentDoc["kind"];
  page: AgentDoc["page"];
  ipSets: string[];
}

export interface IpSet {
  cidrs: Cidr[];
  fetchedAt: string;
}

export interface Key extends SignatureKey {
  /** The imported key, worked out once (null when WebCrypto can't use it). */
  crypto(): Promise<CryptoKey | null>;
}

export interface Signer {
  host: string;
  fetchedAt: string;
  keys: Key[];
  /** The agents that sign with it, in catalog order (the first is its default). */
  agents: string[];
}

export interface Verification {
  maxAgeSeconds: number;
  ipSets: Map<string, IpSet>;
  signers: Map<string, Signer>;
}

export interface Access {
  impersonators: AccessDoc["impersonators"];
  /** Every blocked agent key (for a signature that proves the agent). */
  blocked: Set<string>;
  /** Blocked search engines, previews and monitors: blocked by name only. */
  blockedSearch: Needles<string>;
  /** Every other blocked agent and tool. */
  blockedOther: Needles<string>;
  routes: RouteRule[];
}

export interface Policy {
  version: string;
  ttlSeconds: number;
  mode: Mode;
  content: ContentDoc | null;
  access: Access | null;
  verification: Verification | null;
  /** Agents and search engines (tools aside): what the user agent says the client is. */
  detect: Needles<Agent>;
  /** Tools: only named (for identity and reports), never detected. */
  tools: Needles<Agent>;
  /** `Signature-Agent` hosts that mark a signed agent (signature not checked: see identity/). */
  signerHosts: string[];
  botLike: RegExp;
  crawler: RegExp;
}

/** On a tie, a search engine wins over an AI agent: serving a search engine something else is the costlier mistake. */
const PRECEDENCE: Record<AgentDoc["kind"], number> = { search: 0, ai: 1, tool: 2 };

export function compile(doc: PolicyDoc): Policy {
  const agents = doc.agents.map((a) => ({ doc: a, agent: { key: a.key, kind: a.kind, page: a.page, ipSets: a.ipSets ?? [] } satisfies Agent }));
  const ranked = [...agents].sort((a, b) => PRECEDENCE[a.doc.kind] - PRECEDENCE[b.doc.kind]);
  const index = (list: typeof agents) => needles(list.map(({ doc: a, agent }) => ({ ua: a.ua, uaExact: a.uaExact, value: agent })));

  // Report mode serves and blocks nothing, whatever the policy carries: the site behaves exactly as before.
  const autopilot = doc.mode === "autopilot";
  return {
    version: doc.version,
    ttlSeconds: doc.ttlSeconds,
    mode: doc.mode,
    content: autopilot ? doc.content : null,
    access: autopilot && doc.access ? compileAccess(doc.access, doc.agents) : null,
    verification: doc.verification && compileVerification(doc, agents.map((a) => a.doc)),
    detect: index(ranked.filter((a) => a.doc.kind !== "tool")),
    tools: index(ranked.filter((a) => a.doc.kind === "tool")),
    signerHosts: [...new Set(doc.agents.flatMap((a) => (a.signer ? [a.signer] : [])))],
    botLike: new RegExp(doc.patterns.botLike, "i"),
    crawler: new RegExp(doc.patterns.crawler, "i"),
  };
}

function compileAccess(a: AccessDoc, agents: AgentDoc[]): Access {
  const blocked = new Set(a.blocked);
  const list = (search: boolean) =>
    needles(agents.filter((x) => blocked.has(x.key) && (x.kind === "search") === search).map((x) => ({ ua: x.ua, uaExact: x.uaExact, value: x.key })));
  return { impersonators: a.impersonators, blocked, blockedSearch: list(true), blockedOther: list(false), routes: a.routes };
}

function compileVerification(doc: PolicyDoc, agents: AgentDoc[]): Verification {
  const v = doc.verification!;
  const ipSets = new Map<string, IpSet>();
  for (const [id, set] of Object.entries(v.ipSets)) {
    // A vendor's entry that isn't a CIDR is ignored, not a reason to reject the policy.
    ipSets.set(id, { cidrs: set.cidrs.map(parseCidr).filter((c): c is Cidr => c !== null), fetchedAt: set.fetchedAt });
  }
  const signers = new Map<string, Signer>();
  for (const s of v.signers) {
    if (signers.has(s.host)) continue;
    const signing = agents.filter((a) => a.signer === s.host).map((a) => a.key);
    signers.set(s.host, { host: s.host, fetchedAt: s.fetchedAt, keys: s.keys.map(importable), agents: signing });
  }
  return { maxAgeSeconds: v.maxAgeSeconds, ipSets, signers };
}

function importable(key: SignatureKey): Key {
  let imported: Promise<CryptoKey | null> | null = null;
  return {
    ...key,
    crypto() {
      imported ??= importEd25519(key.x);
      return imported;
    },
  };
}

function importEd25519(x: string): Promise<CryptoKey | null> {
  try {
    const b64 = x.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(x.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey("raw", bytes, { name: "Ed25519" }, false, ["verify"]).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}
