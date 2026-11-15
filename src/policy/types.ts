/** The site's policy, in the exact shape the worker relies on once it has been checked (see sanitize.ts). */

export type PagePreference = "human" | "agent" | "question";

export interface Detection {
  traditionalBots: string[];
  traditionalBotsExact?: string[];
  agentUa: string[];
  agentUaExact?: string[];
  signatureAgentDomains: string[];
  botLikePattern: string;
  humanPageVeto?: {
    exact: [string, PagePreference][];
    contains: [string, PagePreference][];
    botLikePattern: string;
  };
}

export interface Twins {
  enabled: boolean;
  negotiate: boolean;
  suffix: string;
  includePaths?: string[];
  excludePaths?: string[];
  questionParams?: string[];
}

export interface Artifact {
  path: string;
  /** `fallback`: the origin's own file wins (a non-HTML 2xx, or any 3xx); otherwise Dedica's. */
  action?: "proxy" | "fallback" | "block" | "passthrough";
  contentType: string;
  version?: string;
}

/** A path on the customer's domain proxied to Dedica: per method it takes, the Dedica URL that answers. */
export interface Proxy {
  path: string;
  targets: Record<string, string>;
}

/** One vendor's published IP ranges, as Dedica last fetched them. */
export interface IpSet {
  cidrs: string[];
  fetchedAt: string;
}

/** An Ed25519 public key from a Web Bot Auth key directory (JWK `kid` and `x`, base64url). */
export interface SignatureKey {
  kid: string;
  x: string;
  nbf?: number | null;
  exp?: number | null;
}

/** A signing agent (`Signature-Agent`), its keys and the catalog agents it signs for. */
export interface SignatureAgent {
  signatureAgent: string;
  agents: string[];
  fetchedAt: string;
  keys: SignatureKey[];
}

/** What proves who a bot is. Data older than `maxAgeSeconds` is not trusted: a request is then only `claimed`. */
export interface Verification {
  maxAgeSeconds: number;
  /** `[needle, agent key]`, longest needle first. */
  claims: [string, string][];
  claimsExact: [string, string][];
  agentIpSets: Record<string, string[]>;
  ipSets: Record<string, IpSet>;
  signatureAgents: SignatureAgent[];
}

/** A path rule: `block` answers detected AI agents 403 there; `passthrough` hands the path to the origin untouched. */
export interface RouteRule {
  id: string;
  /** `exact`: this path only. `prefix`: this path and everything under it. */
  kind: "exact" | "prefix";
  path: string;
  action: "block" | "passthrough";
}

/** Agent Access: which bots this site blocks, and how to tell who a bot is. */
export interface Access {
  /** Rules are enforced (guardrails on, autopilot). False: the lists are empty and nothing is blocked. */
  enforce: boolean;
  /** `block`: 403 to a request naming a bot whose published ranges it isn't from. */
  impersonators: "flag" | "block";
  /** AI agents and tools blocked by user agent; never a search engine, never a browser navigation. */
  blockedAgentUa: string[];
  blockedAgentUaExact: string[];
  /** Search engines, previews and monitors blocked by name. */
  blockedServeHumanUa: string[];
  blockedServeHumanUaExact: string[];
  /** Agent keys blocked when a signature proves the agent. */
  blockedAgentKeys: string[];
  /** Path rules (exact beats prefix, longer prefix beats shorter). Empty unless enforced. */
  routes: RouteRule[];
  verification: Verification | null;
}

export interface Policy {
  schemaVersion: number;
  ttlSeconds?: number;
  version: string;
  siteId?: string;
  mode: "report" | "autopilot";
  detection: Detection;
  twins: Twins;
  artifacts: Artifact[];
  serve: { baseUrl: string; version: string } | null;
  /** Paths proxied to Dedica (`/ask`, `/mcp`, ...). Empty: none. */
  proxies: Proxy[];
  /** Agent Access (1.4.0). Null: no rules and no verification. */
  access: Access | null;
}
