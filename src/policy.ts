/**
 * The site's policy, fetched from Dedica and cached for a short while (ported from ref.js).
 *
 * - Fresh for `ttlSeconds` (default 30s). After that it is refreshed in the background while the old
 *   one is still used for up to 30s more.
 * - If Dedica is unreachable, a policy that enables serving is kept for at most 15 minutes after its
 *   last successful refresh; otherwise only for the 30s grace. Then the worker passes everything through.
 * - Failures back off (15s; 60s for an unknown schema; 5 min for a rejected token) so a broken
 *   Dedica is never hammered. Only one refresh runs at a time per isolate.
 */

import { POLICY_TIMEOUT_MS, SCHEMA_MAJOR, dedicaInit, dedicaUrl } from "./env";
import type { Artifact, Ctx, Detection, Env, PagePreference, Policy, Proxy, Twins } from "./types";

export const POLICY_FAILURE_GRACE_MS = 30_000;
export const POLICY_OUTAGE_MAX_MS = 15 * 60_000;
const DEFAULT_TTL_S = 30;
export const TTL_MIN_S = 5;
export const TTL_MAX_S = 300;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** Non-empty strings only: an empty needle would match every client. */
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0) : []);
const optionalStrings = (v: unknown): string[] | undefined => (v === undefined ? undefined : strings(v));
const paths = (v: unknown): string[] | undefined => optionalStrings(v)?.filter((p) => p.startsWith("/"));
const string = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);

const PREFERENCES = new Set<PagePreference>(["human", "agent", "question"]);
const ARTIFACT_ACTIONS = new Set(["proxy", "fallback", "block", "passthrough"]);

function preferences(v: unknown): [string, PagePreference][] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (pair): pair is [string, PagePreference] =>
      Array.isArray(pair) && typeof pair[0] === "string" && pair[0].length > 0 && PREFERENCES.has(pair[1] as PagePreference),
  );
}

function detection(d: Obj): Detection {
  const veto = d.humanPageVeto;
  return {
    traditionalBots: strings(d.traditionalBots),
    traditionalBotsExact: optionalStrings(d.traditionalBotsExact),
    agentUa: strings(d.agentUa),
    agentUaExact: optionalStrings(d.agentUaExact),
    signatureAgentDomains: strings(d.signatureAgentDomains),
    botLikePattern: string(d.botLikePattern, ""),
    humanPageVeto: isObject(veto)
      ? { exact: preferences(veto.exact), contains: preferences(veto.contains), botLikePattern: string(veto.botLikePattern, "") }
      : undefined,
  };
}

function twins(t: Obj): Twins {
  // An empty or odd suffix would make every URL a markdown URL: twins are off without a proper one (`.md`).
  const suffix = typeof t.suffix === "string" && /^\.[a-z0-9]{1,16}$/i.test(t.suffix) ? t.suffix : null;
  return {
    enabled: t.enabled === true && suffix !== null,
    negotiate: t.negotiate === true,
    suffix: suffix ?? ".md",
    includePaths: paths(t.includePaths),
    excludePaths: paths(t.excludePaths),
    questionParams: optionalStrings(t.questionParams),
  };
}

function artifacts(v: unknown): Artifact[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObject).flatMap((a): Artifact[] => {
    if (typeof a.path !== "string" || !a.path.startsWith("/")) return [];
    // An action this worker doesn't know keeps the path for the origin, as before.
    const action = a.action === undefined ? undefined : ARTIFACT_ACTIONS.has(a.action as string) ? (a.action as Artifact["action"]) : "passthrough";
    return [{ path: a.path, action, contentType: string(a.contentType, "text/plain; charset=utf-8"), version: typeof a.version === "string" ? a.version : undefined }];
  });
}

function proxies(v: unknown): Proxy[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObject).flatMap((p): Proxy[] => {
    if (typeof p.path !== "string" || !isObject(p.targets)) return [];
    const targets = Object.fromEntries(Object.entries(p.targets).filter(([, url]) => typeof url === "string")) as Record<string, string>;
    return [{ path: p.path, targets }];
  });
}

function serve(v: unknown): Policy["serve"] {
  if (!isObject(v) || typeof v.baseUrl !== "string" || typeof v.version !== "string") return null;
  try {
    new URL(v.baseUrl);
  } catch {
    return null;
  }
  return { baseUrl: v.baseUrl, version: v.version };
}

/**
 * The policy in the exact shape the worker relies on, or null when it can't be used safely (unknown mode, or no
 * detection or twins settings). Lists lose anything that isn't a non-empty string, the TTL is clamped to 5–300 s,
 * and malformed artifacts, proxies and serve settings are dropped, so a bad policy can only serve less, never more.
 */
export function sanitizePolicy(raw: unknown): Policy | null {
  if (!isObject(raw) || raw.schemaVersion !== SCHEMA_MAJOR) return null;
  if ((raw.mode !== "report" && raw.mode !== "autopilot") || !isObject(raw.detection) || !isObject(raw.twins)) return null;
  const ttl = typeof raw.ttlSeconds === "number" && Number.isFinite(raw.ttlSeconds) ? raw.ttlSeconds : DEFAULT_TTL_S;
  return {
    schemaVersion: SCHEMA_MAJOR,
    ttlSeconds: Math.min(TTL_MAX_S, Math.max(TTL_MIN_S, ttl)),
    version: string(raw.version, ""),
    siteId: typeof raw.siteId === "string" ? raw.siteId : undefined,
    mode: raw.mode,
    detection: detection(raw.detection),
    twins: twins(raw.twins),
    artifacts: artifacts(raw.artifacts),
    serve: serve(raw.serve),
    proxies: proxies(raw.proxies),
  };
}

export class PolicyStore {
  policy: Policy | null = null;
  private expiry = 0;
  private fetchedAt = 0;
  private backoffUntil = 0;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly now: () => number = Date.now,
  ) {}

  private async performRefresh(env: Env): Promise<void> {
    if (this.now() < this.backoffUntil) return;
    try {
      const res = await this.fetchFn(dedicaUrl(env, "policy"), dedicaInit(env, POLICY_TIMEOUT_MS, { headers: { accept: "application/json" } }));

      if (res.status === 401 || res.status === 403) {
        this.policy = null;
        console.log(`[dedica] policy ${res.status}: check DEDICA_MIDDLEWARE_TOKEN (rotated or wrong?)`);
        this.backoffUntil = this.now() + 300_000;
        return;
      }
      if (!res.ok) {
        // A definite client error drops the policy; a server error or rate limit keeps the old one.
        if (res.status < 500 && res.status !== 408 && res.status !== 429) this.policy = null;
        console.log(`[dedica] policy ${res.status}`);
        this.backoffUntil = this.now() + 15_000;
        return;
      }

      const raw = (await res.json()) as { schemaVersion?: unknown } | null;
      if (raw?.schemaVersion !== SCHEMA_MAJOR) {
        this.policy = null;
        console.log(`[dedica] policy schemaVersion ${raw?.schemaVersion} != ${SCHEMA_MAJOR}; serving nothing`);
        this.backoffUntil = this.now() + 60_000;
        return;
      }
      const next = sanitizePolicy(raw);
      if (!next) {
        this.policy = null;
        console.log("[dedica] policy malformed (mode, detection or twins); serving nothing");
        this.backoffUntil = this.now() + 60_000;
        return;
      }

      this.policy = next;
      this.fetchedAt = this.now();
      this.expiry = this.now() + (next.ttlSeconds ?? DEFAULT_TTL_S) * 1000;
      this.backoffUntil = 0;
    } catch (err) {
      console.log(`[dedica] policy request failed: ${err}`);
      this.backoffUntil = this.now() + 15_000;
    }
  }

  refresh(env: Env): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.performRefresh(env).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** The last policy, if it may still be used during an outage. */
  retained(): Policy | null {
    if (!this.policy) return null;
    const deadline = this.policy.serve ? this.fetchedAt + POLICY_OUTAGE_MAX_MS : this.expiry + POLICY_FAILURE_GRACE_MS;
    return this.now() < deadline ? this.policy : null;
  }

  /**
   * The policy to use for this request. `blocking`: a request Dedica may answer waits for a missing
   * policy; any other request never waits and gets null (and so passes through).
   */
  async get(env: Env, ctx: Ctx, blocking: boolean): Promise<Policy | null> {
    const now = this.now();
    if (this.policy && now < this.expiry) return this.policy;
    const pending = this.refresh(env);
    ctx.waitUntil(pending);
    if (this.policy && now < this.expiry + POLICY_FAILURE_GRACE_MS) return this.policy;
    if (!blocking) return null;
    await pending;
    return this.retained();
  }
}
