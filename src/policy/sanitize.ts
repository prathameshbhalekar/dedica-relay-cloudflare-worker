/**
 * Checks a policy from Dedica (schema v1) and puts it in the exact shape the worker relies on. A policy that can't be
 * used safely is null; anything malformed inside it is dropped, so a bad policy can only serve less, never more.
 */

import { SCHEMA_MAJOR } from "../protocol";
import type { Access, Artifact, Detection, PagePreference, Policy, Proxy, RouteRule, SignatureAgent, Twins, Verification } from "./types";

export const DEFAULT_TTL_S = 30;
export const TTL_MIN_S = 5;
export const TTL_MAX_S = 300;

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

function pairs(v: unknown): [string, string][] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (pair): pair is [string, string] =>
      Array.isArray(pair) && typeof pair[0] === "string" && pair[0].length > 0 && typeof pair[1] === "string" && pair[1].length > 0,
  );
}

function verification(v: unknown): Verification | null {
  if (!isObject(v)) return null;
  const maxAge = typeof v.maxAgeSeconds === "number" && Number.isFinite(v.maxAgeSeconds) && v.maxAgeSeconds > 0 ? v.maxAgeSeconds : 0;
  const ipSets: Verification["ipSets"] = {};
  if (isObject(v.ipSets)) {
    for (const [id, set] of Object.entries(v.ipSets)) {
      if (isObject(set) && typeof set.fetchedAt === "string") ipSets[id] = { cidrs: strings(set.cidrs), fetchedAt: set.fetchedAt };
    }
  }
  const agentIpSets: Verification["agentIpSets"] = {};
  if (isObject(v.agentIpSets)) {
    for (const [key, ids] of Object.entries(v.agentIpSets)) agentIpSets[key] = strings(ids);
  }
  const signatureAgents: SignatureAgent[] = Array.isArray(v.signatureAgents)
    ? v.signatureAgents.filter(isObject).flatMap((s): SignatureAgent[] => {
        if (typeof s.signatureAgent !== "string" || typeof s.fetchedAt !== "string" || !Array.isArray(s.keys)) return [];
        const keys = s.keys.filter(isObject).flatMap((k) =>
          typeof k.kid === "string" && typeof k.x === "string"
            ? [{ kid: k.kid, x: k.x, nbf: typeof k.nbf === "number" ? k.nbf : null, exp: typeof k.exp === "number" ? k.exp : null }]
            : [],
        );
        return [{ signatureAgent: s.signatureAgent.toLowerCase(), agents: strings(s.agents), fetchedAt: s.fetchedAt, keys }];
      })
    : [];
  // Without a usable age limit nothing can be trusted, so nothing is verified (and nobody is an impersonator).
  if (maxAge === 0) return null;
  return { maxAgeSeconds: maxAge, claims: pairs(v.claims), claimsExact: pairs(v.claimsExact), agentIpSets, ipSets, signatureAgents };
}

/** Path rules. One this worker doesn't understand (another kind or action, a path that isn't a path) is skipped,
 *  never guessed. */
function routes(v: unknown): RouteRule[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObject).flatMap((r): RouteRule[] => {
    const kind = r.kind === "exact" || r.kind === "prefix" ? r.kind : null;
    const action = r.action === "block" || r.action === "passthrough" ? r.action : null;
    if (!kind || !action || typeof r.path !== "string" || !/^\/[^?#\s]*$/.test(r.path)) return [];
    return [{ id: typeof r.id === "string" ? r.id : "", kind, path: r.path, action }];
  });
}

/** Agent Access, or null. A malformed section can only block less: unknown values block nothing. */
function access(v: unknown): Access | null {
  if (!isObject(v)) return null;
  return {
    enforce: v.enforce === true,
    impersonators: v.impersonators === "block" ? "block" : "flag",
    blockedAgentUa: strings(v.blockedAgentUa),
    blockedAgentUaExact: strings(v.blockedAgentUaExact),
    blockedServeHumanUa: strings(v.blockedServeHumanUa),
    blockedServeHumanUaExact: strings(v.blockedServeHumanUaExact),
    blockedAgentKeys: strings(v.blockedAgentKeys),
    routes: routes(v.routes),
    verification: verification(v.verification),
  };
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
    access: access(raw.access),
  };
}
