/** Worker configuration. Set the vars in wrangler.toml and the secrets with `wrangler secret put`. */
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
  /** Optional secret: salt for the daily visitor pseudonym in traffic reports. Without it, no pseudonym is sent. */
  DEDICA_SALT?: string;
  /** Optional kill switch: `1` and the worker passes every request straight to the origin, untouched and unreported. */
  DEDICA_DISABLED?: string;
}

/** Minimal slice of ExecutionContext the worker uses (lets tests pass a plain object). */
export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

/** Dedica's API base, without trailing slashes. */
export function apiBase(env: Env): string {
  return (env.DEDICA_API_URL ?? "").replace(/\/+$/, "");
}

/** The customer's kill switch: `DEDICA_DISABLED=1` (or `true`/`yes`/`on`) and the worker only passes traffic through. */
export function disabled(env: Env): boolean {
  return /^(?:1|true|yes|on)$/i.test((env.DEDICA_DISABLED ?? "").trim());
}

/** Whether the worker has what it needs to talk to Dedica at all. */
export function configured(env: Env): boolean {
  return Boolean(env.DEDICA_SITE_ID && env.DEDICA_MIDDLEWARE_TOKEN && (env.DEDICA_API_URL || env.DEDICA_POLICY_URL));
}
