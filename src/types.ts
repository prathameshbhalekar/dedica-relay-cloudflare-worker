/** Worker configuration. Set the vars in wrangler.toml and the token with `wrangler secret put`. */
export interface Env {
  /** Your site's id from Dedica. Not a secret. Without it the worker only passes traffic through. */
  DEDICA_SITE_ID?: string;
  /** Dedica's API, e.g. https://api.getdedica.com */
  DEDICA_API_URL?: string;
  /** Secret: the middleware token from Dedica onboarding. */
  DEDICA_MIDDLEWARE_TOKEN?: string;
  /** Optional override of the policy URL (testing). */
  DEDICA_POLICY_URL?: string;
  /** Optional pin: the only origin /ask and /mcp may be proxied to. Defaults to DEDICA_API_URL's origin. */
  DEDICA_QUERY_ORIGIN?: string;
}

/** Minimal slice of ExecutionContext the worker uses (lets tests pass a plain object). */
export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

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
}
