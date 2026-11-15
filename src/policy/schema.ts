/**
 * The policy as Dedica sends it (protocol v2), and its check. A policy that breaks any rule below is rejected whole:
 * the worker then has no policy and the origin answers everything, as if the worker weren't there. Keys this worker
 * doesn't know are ignored (a newer Dedica may add some within schema 2).
 *
 * One exception, for data Dedica copies from bot vendors: an IP range that isn't a CIDR is ignored (compile.ts), so
 * one vendor's odd entry can't switch the worker off for every site.
 */

import { SCHEMA_MAJOR } from "../protocol";

export type Mode = "report" | "autopilot";
/** `ai`: may get the agent version. `search`: search engines, link previews and monitors, which always get the
 *  person's page at a normal URL. `tool`: HTTP libraries and scripts, only named and blockable. */
export type AgentKind = "ai" | "search" | "tool";

export interface AgentDoc {
  key: string;
  kind: AgentKind;
  /** Lowercase needles, matched as substrings of the lowercased user agent. */
  ua: string[];
  /** Lowercase user agents, matched whole. */
  uaExact: string[];
  /** What it gets at a `.md` URL: the agent version, or the person's page. Ignored for tools. */
  page: "agent" | "human";
  /** Ids of `verification.ipSets` whose ranges prove a request comes from it. */
  ipSets?: string[];
  /** The Web Bot Auth `Signature-Agent` host it signs with. */
  signer?: string;
}

export interface FileDoc {
  path: string;
  /** `proxy`: Dedica's file. `fallback`: the origin's own file wins (a non-HTML 2xx, or any 3xx); else Dedica's. */
  action: "proxy" | "fallback";
  contentType: string;
  version: string;
}

/** A path on the customer's domain proxied to Dedica: per method it takes, the Dedica URL that answers. */
export interface ProxyDoc {
  path: string;
  methods: Record<string, string>;
}

export interface ContentDoc {
  serveBaseUrl: string;
  /** Serve the agent version at a page's normal URL too (not only at `/page.md`). */
  negotiate: boolean;
  /** Path prefixes that never get an agent version. */
  excludePaths: string[];
  files: FileDoc[];
  proxies: ProxyDoc[];
}

/** A path rule: `block` answers detected AI agents 403 there; `passthrough` hands the path to the origin untouched. */
export interface RouteRule {
  id: string;
  /** `exact`: this path only. `prefix`: this path and everything under it. */
  kind: "exact" | "prefix";
  path: string;
  action: "block" | "passthrough";
}

export interface AccessDoc {
  /** `block`: 403 to a request naming a bot whose published ranges it isn't from. */
  impersonators: "flag" | "block";
  /** Agent keys this site blocks. */
  blocked: string[];
  routes: RouteRule[];
}

export interface IpSetDoc {
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

export interface SignerDoc {
  host: string;
  fetchedAt: string;
  keys: SignatureKey[];
}

/** What proves who a bot is. Data older than `maxAgeSeconds` proves nothing: a request is then only `claimed`. */
export interface VerificationDoc {
  maxAgeSeconds: number;
  ipSets: Record<string, IpSetDoc>;
  signers: SignerDoc[];
}

export interface PolicyDoc {
  schemaVersion: typeof SCHEMA_MAJOR;
  /** Changes whenever what is served can; sent to Dedica with every served file (`X-Dedica-Version`). */
  version: string;
  /** Clamped to 5–300 s. */
  ttlSeconds: number;
  mode: Mode;
  agents: AgentDoc[];
  patterns: {
    /** Unknown clients with no browser fetch metadata that this matches count as agents. */
    botLike: string;
    /** Unknown clients this matches keep the person's page even at a `.md` URL. */
    crawler: string;
  };
  /** Null outside autopilot: nothing is served from Dedica. */
  content: ContentDoc | null;
  /** Null unless the site's Agent Access rules are enforced: nothing is blocked. */
  access: AccessDoc | null;
  /** Null: no identity verdicts. */
  verification: VerificationDoc | null;
}

export const TTL_MIN_S = 5;
export const TTL_MAX_S = 300;

class Invalid extends Error {}

type Obj = Record<string, unknown>;

function fail(where: string, what: string): never {
  throw new Invalid(`${where}: ${what}`);
}

function object(v: unknown, where: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(where, "not an object");
  return v as Obj;
}

function array(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) fail(where, "not a list");
  return v;
}

function string(v: unknown, where: string): string {
  if (typeof v !== "string") fail(where, "not a string");
  return v;
}

/** A non-empty string: an empty needle would match every client. */
function text(v: unknown, where: string): string {
  if (string(v, where).length === 0) fail(where, "empty");
  return v as string;
}

function oneOf<T extends string>(v: unknown, options: readonly T[], where: string): T {
  if (!options.includes(v as T)) fail(where, `not one of ${options.join(", ")}`);
  return v as T;
}

function boolean(v: unknown, where: string): boolean {
  if (typeof v !== "boolean") fail(where, "not true or false");
  return v;
}

function number(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(where, "not a number");
  return v;
}

function texts(v: unknown, where: string): string[] {
  return array(v, where).map((s, i) => text(s, `${where}[${i}]`));
}

function needles(v: unknown, where: string): string[] {
  return texts(v, where).map((n, i) => (n === n.toLowerCase() ? n : fail(`${where}[${i}]`, "not lowercase")));
}

/** `/` followed by no `?`, `#` or whitespace (`/` itself only when `root`). */
function path(v: unknown, where: string, root = true): string {
  const p = string(v, where);
  if (!(root ? /^\/[^?#\s]*$/ : /^\/[^?#\s]+$/).test(p)) fail(where, "not a path");
  return p;
}

function absoluteUrl(v: unknown, where: string): string {
  const u = string(v, where);
  try {
    new URL(u);
  } catch {
    fail(where, "not an absolute URL");
  }
  return u;
}

function pattern(v: unknown, where: string): string {
  const p = string(v, where);
  try {
    new RegExp(p, "i");
  } catch {
    fail(where, "not a regular expression");
  }
  return p;
}

function optionalNumber(v: unknown, where: string): number | null {
  return v === undefined || v === null ? null : number(v, where);
}

function agent(v: unknown, where: string): AgentDoc {
  const a = object(v, where);
  const doc: AgentDoc = {
    key: text(a.key, `${where}.key`),
    kind: oneOf(a.kind, ["ai", "search", "tool"] as const, `${where}.kind`),
    ua: needles(a.ua, `${where}.ua`),
    uaExact: needles(a.uaExact, `${where}.uaExact`),
    page: oneOf(a.page, ["agent", "human"] as const, `${where}.page`),
  };
  if (a.ipSets !== undefined) doc.ipSets = texts(a.ipSets, `${where}.ipSets`);
  if (a.signer !== undefined) doc.signer = text(a.signer, `${where}.signer`).toLowerCase();
  return doc;
}

function content(v: unknown, where: string): ContentDoc {
  const c = object(v, where);
  return {
    serveBaseUrl: absoluteUrl(c.serveBaseUrl, `${where}.serveBaseUrl`),
    negotiate: boolean(c.negotiate, `${where}.negotiate`),
    excludePaths: array(c.excludePaths, `${where}.excludePaths`).map((p, i) => path(p, `${where}.excludePaths[${i}]`)),
    files: array(c.files, `${where}.files`).map((f, i) => {
      const w = `${where}.files[${i}]`;
      const file = object(f, w);
      return {
        path: path(file.path, `${w}.path`),
        action: oneOf(file.action, ["proxy", "fallback"] as const, `${w}.action`),
        contentType: text(file.contentType, `${w}.contentType`),
        version: string(file.version, `${w}.version`),
      };
    }),
    proxies: array(c.proxies, `${where}.proxies`).map((p, i) => {
      const w = `${where}.proxies[${i}]`;
      const proxy = object(p, w);
      const methods = object(proxy.methods, `${w}.methods`);
      return {
        path: path(proxy.path, `${w}.path`, false),
        methods: Object.fromEntries(Object.entries(methods).map(([m, url]) => [m, absoluteUrl(url, `${w}.methods.${m}`)])),
      };
    }),
  };
}

function access(v: unknown, where: string): AccessDoc {
  const a = object(v, where);
  return {
    impersonators: oneOf(a.impersonators, ["flag", "block"] as const, `${where}.impersonators`),
    blocked: texts(a.blocked, `${where}.blocked`),
    routes: array(a.routes, `${where}.routes`).map((r, i) => {
      const w = `${where}.routes[${i}]`;
      const route = object(r, w);
      return {
        id: string(route.id, `${w}.id`),
        kind: oneOf(route.kind, ["exact", "prefix"] as const, `${w}.kind`),
        path: path(route.path, `${w}.path`),
        action: oneOf(route.action, ["block", "passthrough"] as const, `${w}.action`),
      };
    }),
  };
}

function verification(v: unknown, where: string): VerificationDoc {
  const x = object(v, where);
  const maxAgeSeconds = number(x.maxAgeSeconds, `${where}.maxAgeSeconds`);
  if (maxAgeSeconds <= 0) fail(`${where}.maxAgeSeconds`, "not positive");
  const ipSets = object(x.ipSets, `${where}.ipSets`);
  return {
    maxAgeSeconds,
    ipSets: Object.fromEntries(
      Object.entries(ipSets).map(([id, s]) => {
        const w = `${where}.ipSets.${id}`;
        const set = object(s, w);
        return [id, { cidrs: array(set.cidrs, `${w}.cidrs`).map((c, i) => string(c, `${w}.cidrs[${i}]`)), fetchedAt: string(set.fetchedAt, `${w}.fetchedAt`) }];
      }),
    ),
    signers: array(x.signers, `${where}.signers`).map((s, i) => {
      const w = `${where}.signers[${i}]`;
      const signer = object(s, w);
      return {
        host: text(signer.host, `${w}.host`).toLowerCase(),
        fetchedAt: string(signer.fetchedAt, `${w}.fetchedAt`),
        keys: array(signer.keys, `${w}.keys`).map((k, j) => {
          const kw = `${w}.keys[${j}]`;
          const key = object(k, kw);
          return { kid: string(key.kid, `${kw}.kid`), x: string(key.x, `${kw}.x`), nbf: optionalNumber(key.nbf, `${kw}.nbf`), exp: optionalNumber(key.exp, `${kw}.exp`) };
        }),
      };
    }),
  };
}

function nullable<T>(v: unknown, where: string, parse: (v: unknown, where: string) => T): T | null {
  return v === null ? null : parse(v, where);
}

/** The policy, checked, or why it can't be used. */
export function parsePolicy(raw: unknown): { policy: PolicyDoc } | { error: string } {
  try {
    const p = object(raw, "policy");
    if (p.schemaVersion !== SCHEMA_MAJOR) fail("schemaVersion", `${String(p.schemaVersion)} is not ${SCHEMA_MAJOR}`);
    const patterns = object(p.patterns, "patterns");
    const policy: PolicyDoc = {
      schemaVersion: SCHEMA_MAJOR,
      version: string(p.version, "version"),
      ttlSeconds: Math.min(TTL_MAX_S, Math.max(TTL_MIN_S, number(p.ttlSeconds, "ttlSeconds"))),
      mode: oneOf(p.mode, ["report", "autopilot"] as const, "mode"),
      agents: array(p.agents, "agents").map((a, i) => agent(a, `agents[${i}]`)),
      patterns: { botLike: pattern(patterns.botLike, "patterns.botLike"), crawler: pattern(patterns.crawler, "patterns.crawler") },
      content: nullable(p.content, "content", content),
      access: nullable(p.access, "access", access),
      verification: nullable(p.verification, "verification", verification),
    };
    return { policy };
  } catch (error) {
    if (error instanceof Invalid) return { error: error.message };
    throw error;
  }
}
