import { describe, expect, it } from "vitest";
import { routeFor } from "../src/decide/access";
import { parseCidr, parseIp } from "../src/identity/ip";
import { parseSignatureInput, verifiedSigner } from "../src/identity/signature";
import { claimedAgent, identify, ipTier } from "../src/identity/verdict";
import { sanitizePolicy } from "../src/policy/sanitize";
import type { Access, Policy, Verification } from "../src/policy/types";
import { API, BROWSER_UA, FakeCtx, GOOGLEBOT_UA, GPTBOT_UA, SITE, browserHeaders, env, eventBodies, get, harness, policy } from "./helpers";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const FRESH = "2026-11-15T06:00:00Z";
const STALE = "2026-10-01T00:00:00Z";
const OPENAI_IP = "20.171.207.5";
const GOOGLE_IP = "66.249.66.1";
const ELSEWHERE_IP = "198.51.100.9";

function verification(overrides: Partial<Verification> = {}): Verification {
  return {
    maxAgeSeconds: 7 * 24 * 3600,
    claims: [
      ["chatgpt-user", "chatgpt-user"],
      ["googlebot", "googlebot"],
      ["claudebot", "claudebot"],
      ["gptbot", "gptbot"],
    ],
    claimsExact: [],
    agentIpSets: { gptbot: ["openai-gptbot"], googlebot: ["google-common"] },
    ipSets: {
      "openai-gptbot": { cidrs: ["20.171.207.0/24"], fetchedAt: FRESH },
      "google-common": { cidrs: ["66.249.64.0/19", "2001:4860:4801:10::/64"], fetchedAt: FRESH },
    },
    signatureAgents: [],
    ...overrides,
  };
}

function access(overrides: Partial<Access> = {}): Access {
  return {
    enforce: true,
    impersonators: "flag",
    blockedAgentUa: [],
    blockedAgentUaExact: [],
    blockedServeHumanUa: [],
    blockedServeHumanUaExact: [],
    blockedAgentKeys: [],
    routes: [],
    verification: verification(),
    ...overrides,
  };
}

function withAccess(a: Access | null, overrides: Partial<Policy> = {}): Policy {
  return policy({ access: a, ...overrides });
}

async function run(request: Request, p: Policy, options: Parameters<typeof harness>[0] = {}) {
  const h = harness({ policy: p, now: () => NOW, ...options });
  await h.worker.policies.refresh(env);
  const ctx = new FakeCtx();
  const res = await h.worker.fetch(request, env, ctx);
  await ctx.drain();
  return { res, events: eventBodies(h.events), originCalls: h.originCalls, calls: h.calls };
}

describe("IP ranges", () => {
  it("parses IPv4, IPv6 and IPv4-mapped addresses", () => {
    expect(parseIp("192.0.2.1")).toEqual({ v6: false, value: 0xc0000201n });
    expect(parseIp("[2001:db8::1]")?.v6).toBe(true);
    expect(parseIp("::ffff:192.0.2.1")).toEqual({ v6: false, value: 0xc0000201n });
    for (const bad of ["300.1.1.1", "1.2.3", "2001:db8:::1", "nope", ""]) expect(parseIp(bad)).toBeNull();
  });

  it("parses CIDRs and rejects malformed ones", () => {
    expect(parseCidr("10.0.0.0/8")).toMatchObject({ v6: false, mask: 0xff000000n });
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("10.0.0.0/8/1")).toBeNull();
  });

  it("verifies a bot from its ranges, flags one from elsewhere, and only claims without fresh data", () => {
    const v = verification();
    expect(ipTier(v, "gptbot", OPENAI_IP, NOW)).toBe("verified");
    expect(ipTier(v, "googlebot", "2001:4860:4801:10::5", NOW)).toBe("verified");
    expect(ipTier(v, "gptbot", ELSEWHERE_IP, NOW)).toBe("impersonator");
    expect(ipTier(v, "claudebot", ELSEWHERE_IP, NOW)).toBe("claimed"); // no published ranges
    expect(ipTier(v, "gptbot", null, NOW)).toBe("claimed");
    const stale = verification({ ipSets: { "openai-gptbot": { cidrs: ["20.171.207.0/24"], fetchedAt: STALE } } });
    expect(ipTier(stale, "gptbot", ELSEWHERE_IP, NOW)).toBe("claimed");
  });

  it("names the bot by the longest needle first", () => {
    expect(claimedAgent(verification(), "mozilla/5.0 (compatible; chatgpt-user/1.0)")).toBe("chatgpt-user");
    expect(claimedAgent(verification(), BROWSER_UA.toLowerCase())).toBeNull();
  });
});

describe("Web Bot Auth", () => {
  async function signer() {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    const x = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return { pair, x };
  }

  async function signed(
    options: { components?: string; created?: number; expires?: number; tamper?: boolean; keyid?: string } = {},
  ): Promise<{ request: Request; v: Verification }> {
    const { pair, x } = await signer();
    const created = options.created ?? Math.floor(NOW / 1000) - 5;
    const expires = options.expires ?? created + 300;
    const components = options.components ?? '"@authority" "signature-agent"';
    const params = `(${components});created=${created};expires=${expires};keyid="k1";alg="ed25519";tag="web-bot-auth"`;
    const agentHeader = '"https://chatgpt.com"';
    const lines = components
      .split(" ")
      .map((c) => c.replaceAll('"', ""))
      .map((c) => `"${c}": ${c === "@authority" ? "shop.example" : agentHeader}`);
    const base = [...lines, `"@signature-params": ${params}`].join("\n");
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(base)));
    const request = new Request(`${SITE}/pricing`, {
      headers: {
        "user-agent": BROWSER_UA,
        "signature-agent": options.tamper ? '"https://evil.example"' : agentHeader,
        "signature-input": `sig1=${params}`,
        signature: `sig1=:${btoa(String.fromCharCode(...sig))}:`,
      },
    });
    const v = verification({
      signatureAgents: [{ signatureAgent: "chatgpt.com", agents: ["chatgpt-user", "chatgpt-agent"], fetchedAt: FRESH, keys: [{ kid: options.keyid ?? "k1", x }] }],
    });
    return { request, v };
  }

  it("parses a Signature-Input member", () => {
    expect(parseSignatureInput('("@authority" "signature-agent";key="sig1");created=1;keyid="k";alg="ed25519"')).toEqual({
      components: [{ name: "@authority" }, { name: "signature-agent", key: "sig1" }],
      created: 1,
      keyid: "k",
      alg: "ed25519",
    });
    expect(parseSignatureInput("not a list")).toBeNull();
  });

  it("verifies a valid signature from a known signing agent", async () => {
    const { request, v } = await signed();
    expect((await verifiedSigner(v, request, NOW))?.signatureAgent).toBe("chatgpt.com");
    expect(await identify(v, request, BROWSER_UA.toLowerCase(), false, NOW)).toEqual({ tier: "verified", agent: "chatgpt-user", signed: true });
  });

  it("rejects a signature that doesn't cover Signature-Agent or this site, an unknown key, an expired one, or another signer", async () => {
    for (const options of [
      { components: '"@authority"' },
      { components: '"signature-agent"' },
      { keyid: "other" },
      { created: Math.floor(NOW / 1000) - 3600, expires: Math.floor(NOW / 1000) - 600 },
      { tamper: true },
    ]) {
      const { request, v } = await signed(options);
      expect(await verifiedSigner(v, request, NOW), JSON.stringify(options)).toBeNull();
    }
  });

  it("rejects a signature without the web-bot-auth tag or without created and expires", async () => {
    for (const params of ["created=1;expires=99999999999", ""]) {
      const { request, v } = await signed();
      const raw = request.headers.get("signature-input") ?? "";
      const stripped = params === "" ? raw.replace(/;tag="web-bot-auth"/, "") : raw.replace(/;created=\d+;expires=\d+/, "");
      const headers = new Headers(request.headers);
      headers.set("signature-input", stripped);
      expect(await verifiedSigner(v, new Request(request.url, { headers }), NOW)).toBeNull();
    }
  });
});

describe("Agent Access enforcement", () => {
  it("blocks a blocked AI crawler with a 403 and reports the rule", async () => {
    const p = withAccess(access({ blockedAgentUa: ["gptbot"] }));
    const { res, events, originCalls } = await run(get("/pricing", { "user-agent": GPTBOT_UA, "cf-connecting-ip": OPENAI_IP }), p);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Not available to this client.");
    expect(originCalls).toHaveLength(0);
    expect(events[0]).toMatchObject({ outcome: "blocked", block_rule: "crawler", client: { verification: "verified", agent: "gptbot" } });
    expect(JSON.stringify(events[0])).not.toContain(OPENAI_IP);
  });

  it("never blocks a search engine or a browser navigation through the agent list", async () => {
    const p = withAccess(access({ blockedAgentUa: ["googlebot", "gptbot"] }));
    for (const request of [get("/pricing", { "user-agent": GOOGLEBOT_UA }), get("/pricing", { ...browserHeaders, "user-agent": GPTBOT_UA })]) {
      const { res } = await run(request, p);
      expect(res.status).not.toBe(403);
    }
  });

  it("has no exemption list: naming Dedica's gateway in the user agent doesn't help a blocked bot", async () => {
    // User-agent rules only bind bots that name themselves; a longer search-engine or monitor name in the user agent
    // still makes a client a search engine (as on Ora). What catches a bot faking a name is impersonator blocking.
    const p = withAccess(access({ blockedAgentUa: ["gptbot"] }));
    expect((await run(get("/pricing", { "user-agent": `${GPTBOT_UA} DedicaAgentGateway/0.1` }), p)).res.status).toBe(403);
    expect((await run(get("/pricing", { "user-agent": "DedicaBot/0.1 (+https://getdedica.com/bot)" }), p)).res.status).not.toBe(403);
  });

  it("blocks a search engine only by name", async () => {
    const { res, events } = await run(get("/", { "user-agent": GOOGLEBOT_UA }), withAccess(access({ blockedServeHumanUa: ["googlebot"] })));
    expect(res.status).toBe(403);
    expect(events[0]).toMatchObject({ block_rule: "serve_human" });
  });

  it("blocks impersonators only when told to, and only those whose vendor publishes ranges", async () => {
    const fake = get("/", { "user-agent": GOOGLEBOT_UA, "cf-connecting-ip": ELSEWHERE_IP });
    const flagged = await run(fake, withAccess(access({ impersonators: "flag" })));
    expect(flagged.res.status).toBe(200);
    expect(flagged.events[0]).toMatchObject({ client: { verification: "impersonator", agent: "googlebot" } });
    expect(flagged.events[0].block_rule).toBeUndefined();

    const blocked = await run(get("/", { "user-agent": GOOGLEBOT_UA, "cf-connecting-ip": ELSEWHERE_IP }), withAccess(access({ impersonators: "block" })));
    expect(blocked.res.status).toBe(403);
    expect(blocked.events[0]).toMatchObject({ block_rule: "impersonator" });

    const real = await run(get("/", { "user-agent": GOOGLEBOT_UA, "cf-connecting-ip": GOOGLE_IP }), withAccess(access({ impersonators: "block" })));
    expect(real.res.status).toBe(200);
    expect(real.events[0]).toMatchObject({ client: { verification: "verified" } });

    const claude = await run(get("/", { "user-agent": "ClaudeBot/1.0", "cf-connecting-ip": ELSEWHERE_IP }), withAccess(access({ impersonators: "block" })));
    expect(claude.res.status).toBe(200);
    expect(claude.events[0]).toMatchObject({ client: { verification: "claimed", agent: "claudebot" } });
  });

  it("blocks nothing when rules aren't enforced or the site is in report mode, but still reports the verdict", async () => {
    const off = await run(get("/pricing", { "user-agent": GPTBOT_UA, "cf-connecting-ip": OPENAI_IP }), withAccess(access({ enforce: false, blockedAgentUa: ["gptbot"] })));
    expect(off.res.status).toBe(200);
    expect(off.events[0]).toMatchObject({ client: { verification: "verified" } });
    const report = await run(get("/pricing", { "user-agent": GPTBOT_UA }), withAccess(access({ blockedAgentUa: ["gptbot"] }), { mode: "report" }));
    expect(report.res.status).toBe(200);
  });

  it("still blocks a bot that sends Dedica's crawler header, and lets the crawler through to the origin, unreported", async () => {
    const p = withAccess(access({ blockedAgentUa: ["gptbot"] }));
    const forged = await run(get("/pricing", { "user-agent": GPTBOT_UA, "x-dedica-origin-fetch": "1" }), p);
    expect(forged.res.status).toBe(403);
    expect(forged.events[0]).toMatchObject({ outcome: "blocked", block_rule: "crawler" });

    const crawler = await run(get("/pricing", { "user-agent": "DedicaBot/0.1 (+https://getdedica.com/bot)", "x-dedica-origin-fetch": "1" }), p);
    expect(crawler.res.status).toBe(200);
    expect(await crawler.res.text()).toBe("origin page");
    expect(crawler.events).toHaveLength(0);
  });

  it("adds no verdict to events without verification data, and old policies parse without access", async () => {
    const { events } = await run(get("/pricing", { "user-agent": GPTBOT_UA }), withAccess(null));
    expect((events[0].client as Record<string, unknown>).verification).toBeUndefined();
    const { access: _ignored, ...old } = policy();
    expect(sanitizePolicy(old)?.access).toBeNull();
  });

  it("drops verification without a usable age limit, and coerces unknown values to block nothing", () => {
    const parsed = sanitizePolicy({ ...policy(), access: { enforce: "yes", impersonators: "maybe", blockedAgentUa: ["", 1, "gptbot"], verification: { maxAgeSeconds: 0 } } });
    expect(parsed?.access).toMatchObject({ enforce: false, impersonators: "flag", blockedAgentUa: ["gptbot"], verification: null });
  });
});

describe("robots.txt", () => {
  // Dedica serves the whole file (the site's own rules plus the groups for blocked bots) as a `proxy` artifact.
  const robotsPolicy = (a: Access = access()) =>
    withAccess(a, { artifacts: [{ path: "/robots.txt", action: "proxy", contentType: "text/plain; charset=utf-8", version: "v1" }] });
  const ours = () => new Response("User-agent: *\nDisallow: /admin\n\nUser-agent: GPTBot\nDisallow: /\n", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });

  it("serves Dedica's file, even to a bot it blocks", async () => {
    const { res } = await run(get("/robots.txt", { "user-agent": GPTBOT_UA }), robotsPolicy(access({ blockedAgentUa: ["gptbot"] })), { serve: ours });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("User-agent: GPTBot\nDisallow: /");
  });

  it("serves the origin's own file when Dedica has none (a 404 from Dedica)", async () => {
    const { res } = await run(get("/robots.txt"), robotsPolicy(), { origin: () => new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } }) });
    expect(await res.text()).toBe("User-agent: *\nAllow: /\n");
  });

  it("treats an artifact action it doesn't know (such as the retired merge) as passthrough", () => {
    const parsed = sanitizePolicy({ ...policy(), artifacts: [{ path: "/robots.txt", action: "merge", contentType: "text/plain" }] });
    expect(parsed?.artifacts[0].action).toBe("passthrough");
  });
});

describe("signed agents", () => {
  it("blocks an agent proven by its signature when its key is blocked, whatever its user agent", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    const x = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const created = Math.floor(NOW / 1000);
    const params = `("@authority" "signature-agent");created=${created};expires=${created + 60};keyid="k1";alg="ed25519";tag="web-bot-auth"`;
    const base = `"@authority": shop.example\n"signature-agent": "https://chatgpt.com"\n"@signature-params": ${params}`;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(base)));
    const request = get("/pricing", {
      "user-agent": BROWSER_UA,
      "signature-agent": '"https://chatgpt.com"',
      "signature-input": `sig1=${params}`,
      signature: `sig1=:${btoa(String.fromCharCode(...sig))}:`,
    });
    const v = verification({ signatureAgents: [{ signatureAgent: "chatgpt.com", agents: ["chatgpt-agent"], fetchedAt: FRESH, keys: [{ kid: "k1", x }] }] });
    const { res, events } = await run(request, withAccess(access({ verification: v, blockedAgentKeys: ["chatgpt-agent"] })));
    expect(res.status).toBe(403);
    expect(events[0]).toMatchObject({ block_rule: "crawler", client: { verification: "verified", agent: "chatgpt-agent" } });
  });
});

describe("Agent Access on proxied paths (/ask, /mcp)", () => {
  const MCP = `${API}/api/v1/middleware/query/mcp`;
  const ASK = `${API}/api/v1/middleware/query/ask`;
  const proxied = (a: Access | null) =>
    withAccess(a, { proxies: [{ path: "/mcp", targets: { POST: MCP } }, { path: "/ask", targets: { GET: ASK } }] });
  const mcpCall = (headers: Record<string, string>) =>
    new Request(`${SITE}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  const queryCalls = (calls: { url: string }[]) => calls.filter((c) => new URL(c.url).pathname.startsWith("/api/v1/middleware/query/"));

  it("answers a blocked bot with a JSON 403 before anything reaches Dedica", async () => {
    const { res, events, calls, originCalls } = await run(mcpCall({ "user-agent": GPTBOT_UA }), proxied(access({ blockedAgentUa: ["gptbot"] })));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "QUERY_FORBIDDEN", message: "Not available to this client." });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(queryCalls(calls)).toHaveLength(0);
    expect(originCalls).toHaveLength(0);
    expect(events[0]).toMatchObject({ path: "/mcp", outcome: "blocked", block_rule: "crawler" });
  });

  it("blocks impersonators and search engines blocked by name on /ask too", async () => {
    const fake = await run(get("/ask?q=hi", { "user-agent": GOOGLEBOT_UA, "cf-connecting-ip": ELSEWHERE_IP }), proxied(access({ impersonators: "block" })));
    expect(fake.res.status).toBe(403);
    expect(fake.events[0]).toMatchObject({ block_rule: "impersonator" });
    const named = await run(get("/ask?q=hi", { "user-agent": GOOGLEBOT_UA, "cf-connecting-ip": GOOGLE_IP }), proxied(access({ blockedServeHumanUa: ["googlebot"] })));
    expect(named.res.status).toBe(403);
    expect(named.events[0]).toMatchObject({ block_rule: "serve_human" });
  });

  it("proxies everyone else, and everything while rules aren't enforced", async () => {
    for (const [request, a] of [
      [mcpCall({ "user-agent": "Claude-User/1.0" }), access({ blockedAgentUa: ["gptbot"] })],
      [mcpCall({ "user-agent": GPTBOT_UA }), access({ enforce: false, blockedAgentUa: ["gptbot"] })],
      [mcpCall({ "user-agent": "DedicaAgentGateway/0.1" }), access({ blockedAgentUa: ["gptbot"] })],
    ] as const) {
      const h = harness({ policy: proxied(a), now: () => NOW });
      await h.worker.policies.refresh(env);
      const res = await h.worker.fetch(request, env, new FakeCtx());
      expect(res.status, request.headers.get("user-agent") ?? "").not.toBe(403);
      expect(queryCalls(h.calls)).toHaveLength(1); // forwarded to Dedica's query API
    }
  });
});


describe("route rules", () => {
  const rule = (kind: "exact" | "prefix", path: string, action: "block" | "passthrough") => ({ id: `${kind}:${path}`, kind, path, action });
  const markdown = () => new Response("# agent version", { status: 200, headers: { "content-type": "text/markdown" } });

  it("matches exact before prefix, the longest prefix first, ignoring trailing and repeated slashes", () => {
    const routes = [rule("prefix", "/docs", "block"), rule("prefix", "/docs/api/", "passthrough"), rule("exact", "/docs/api/v1", "block")];
    expect(routeFor(routes, "/docs/intro")?.id).toBe("prefix:/docs");
    expect(routeFor(routes, "/docs//api/x/")?.id).toBe("prefix:/docs/api/");
    expect(routeFor(routes, "/docs/api/v1/")?.id).toBe("exact:/docs/api/v1");
    expect(routeFor(routes, "/documents")).toBeNull();
    expect(routeFor([rule("prefix", "/", "block")], "/anything")?.id).toBe("prefix:/");
  });

  it("blocks AI agents on a blocked route and its .md version, never people or search engines", async () => {
    const p = withAccess(access({ routes: [rule("prefix", "/admin", "block")] }));
    const agent = await run(get("/admin/users", { "user-agent": GPTBOT_UA }), p);
    expect(agent.res.status).toBe(403);
    expect(agent.events[0]).toMatchObject({ outcome: "blocked", block_rule: "route" });
    expect((await run(get("/admin.md", { "user-agent": GPTBOT_UA }), p, { serve: markdown })).res.status).toBe(403);
    expect((await run(get("/admin/users", browserHeaders), p)).res.status).toBe(200);
    expect((await run(get("/admin/users", { "user-agent": GOOGLEBOT_UA }), p)).res.status).toBe(200);
    expect((await run(get("/pricing", { "user-agent": GPTBOT_UA }), p, { serve: markdown })).res.status).toBe(200);
  });

  it("hands a passthrough route to the origin: no agent version, no .md, nothing asked of Dedica", async () => {
    const p = withAccess(access({ routes: [rule("exact", "/pricing", "passthrough")] }));
    for (const path of ["/pricing", "/pricing.md"]) {
      const { res, calls } = await run(get(path, { "user-agent": GPTBOT_UA }), p, { serve: markdown });
      expect(await res.text()).toBe("origin page");
      expect(calls.filter((c) => new URL(c.url).pathname.startsWith("/api/v1/middleware/serve/"))).toHaveLength(0);
    }
  });

  it("applies to proxied paths: a blocked route is a JSON 403 for agents, a passthrough one is the site's own", async () => {
    const proxies = [{ path: "/mcp", targets: { POST: `${API}/api/v1/middleware/query/mcp` } }];
    const call = () => new Request(`${SITE}/mcp`, { method: "POST", headers: { "user-agent": GPTBOT_UA, "content-type": "application/json" }, body: "{}" });
    const blocked = await run(call(), withAccess(access({ routes: [rule("exact", "/mcp", "block")] }), { proxies }));
    expect(blocked.res.status).toBe(403);
    expect(await blocked.res.json()).toMatchObject({ error: "QUERY_FORBIDDEN" });
    const own = await run(call(), withAccess(access({ routes: [rule("exact", "/mcp", "passthrough")] }), { proxies }));
    expect(own.originCalls).toHaveLength(1);
    expect(own.calls.filter((c) => new URL(c.url).pathname.startsWith("/api/v1/middleware/query/"))).toHaveLength(0);
  });

  it("ignores routes while rules aren't enforced, and skips rules it doesn't understand", async () => {
    const off = await run(get("/admin", { "user-agent": GPTBOT_UA }), withAccess(access({ enforce: false, routes: [rule("prefix", "/admin", "block")] })));
    expect(off.res.status).toBe(200);
    const parsed = sanitizePolicy({
      ...policy(),
      access: { enforce: true, routes: [{ kind: "glob", path: "/a*", action: "block" }, { kind: "exact", path: "nope", action: "block" }, { kind: "exact", path: "/x", action: "serve" }, rule("exact", "/ok", "block")] },
    });
    expect(parsed?.access?.routes).toEqual([rule("exact", "/ok", "block")]);
  });
});
