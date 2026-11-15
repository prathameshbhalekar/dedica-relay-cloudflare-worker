/** The worker never gets in the way of traffic that worked before it: kill switch, fallbacks, limits, bad policies. */

import { describe, expect, it } from "vitest";

import { NEGOTIATE_TIMEOUT_MS } from "../src/protocol";
import { compile } from "../src/policy/compile";
import { type PolicyDoc, parsePolicy } from "../src/policy/schema";
import { FakeCtx, GPTBOT_UA, backendPolicy, content, env, get, harness, policy, serveCalls } from "./helpers";

const markdown = () => new Response("# Pricing\n", { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } });

/** A fake Dedica call that never answers until its signal aborts, like a stalled upstream. */
const hang = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

describe("kill switch (DEDICA_DISABLED)", () => {
  const off = { ...env, DEDICA_DISABLED: "1" };

  it("passes every request to the origin with no call to Dedica and no report", async () => {
    const h = harness({ serve: () => markdown() });
    const ctx = new FakeCtx();
    for (const path of ["/pricing.md", "/pricing", "/llms.txt", "/.well-known/dedica.json"]) {
      const res = await h.worker.fetch(get(path, { "user-agent": GPTBOT_UA }), off, ctx);
      expect(await res.text()).toBe("origin page");
    }
    await ctx.drain();
    expect(h.calls).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(h.originCalls).toHaveLength(4);
  });

  it("still says so on the status endpoint, and skips the heartbeat", async () => {
    const h = harness();
    const body = (await (await h.worker.fetch(get("/__dedica/status"), off, new FakeCtx())).json()) as Record<string, unknown>;
    expect(body.disabled).toBe(true);
    await h.worker.heartbeat(off);
    expect(h.calls).toHaveLength(0);
  });

  it("only takes an explicit yes", async () => {
    const h = harness({ serve: () => markdown() });
    const res = await h.worker.fetch(get("/pricing.md", { "user-agent": GPTBOT_UA }), { ...env, DEDICA_DISABLED: "0" }, new FakeCtx());
    expect(await res.text()).toBe("# Pricing\n");
  });
});

describe("never negotiates API calls or sub-requests", () => {
  it.each([
    ["an Authorization header", "/api/users/1", { authorization: "Bearer x" }],
    ["a cookie", "/account", { cookie: "session=1" }],
    ["a Range request", "/video", { range: "bytes=0-99" }],
    ["an Upgrade", "/socket", { upgrade: "websocket" }],
    ["an XHR marker", "/cart", { "x-requested-with": "XMLHttpRequest" }],
    ["a JSON Accept (axios default)", "/api/items", { accept: "application/json, text/plain, */*" }],
    ["a browser fetch()", "/api/items", { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" }],
    ["a static file", "/app.mjs", {}],
  ])("skips %s", async (_, path, extra) => {
    const h = harness({ serve: () => markdown() });
    await h.worker.policies.refresh(env);
    const res = await h.worker.fetch(get(path, { "user-agent": "okhttp/4.12.0", ...extra }), env, new FakeCtx());
    expect(await res.text()).toBe("origin page");
    expect(serveCalls(h.calls)).toHaveLength(0);
  });

  it("still negotiates a plain agent page read", async () => {
    const h = harness({ serve: () => markdown() });
    const res = await h.worker.fetch(get("/pricing", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
    expect(await res.text()).toBe("# Pricing\n");
  });

  it("keeps explicit .md URLs for clients that send a cookie", async () => {
    const h = harness({ serve: () => markdown() });
    const res = await h.worker.fetch(get("/pricing.md", { "user-agent": GPTBOT_UA, cookie: "a=1" }), env, new FakeCtx());
    expect(await res.text()).toBe("# Pricing\n");
  });
});

describe("a slow Dedica", () => {
  it(`gives up on a negotiated page after ${NEGOTIATE_TIMEOUT_MS} ms and the origin answers`, async () => {
    const h = harness({ serve: (_, init) => hang(init) });
    await h.worker.policies.refresh(env);
    const started = Date.now();
    const res = await h.worker.fetch(get("/pricing", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
    const waited = Date.now() - started;
    expect(await res.text()).toBe("origin page");
    expect(waited).toBeGreaterThanOrEqual(NEGOTIATE_TIMEOUT_MS - 50);
    expect(waited).toBeLessThan(NEGOTIATE_TIMEOUT_MS + 1_000);
  });

  it("releases every waiting request as soon as one call fails", async () => {
    let n = 0;
    const h = harness({
      serve: (_, init) => {
        n += 1;
        if (n === 1) return hang(init);
        throw new Error("network down");
      },
    });
    await h.worker.policies.refresh(env);
    const ctx = new FakeCtx();
    const started = Date.now();
    const stalled = h.worker.fetch(get("/a.md", { "user-agent": GPTBOT_UA }), env, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.worker.fetch(get("/b.md", { "user-agent": GPTBOT_UA }), env, ctx);
    expect(await (await stalled).text()).toBe("origin page");
    expect(Date.now() - started).toBeLessThan(1_000);
    // And the backoff holds: the next request doesn't ask Dedica at all.
    await h.worker.fetch(get("/c.md", { "user-agent": GPTBOT_UA }), env, ctx);
    expect(serveCalls(h.calls)).toHaveLength(2);
  });
});

describe("policy validation", () => {
  const rejected = (raw: unknown) => {
    const parsed = parsePolicy(raw);
    return "error" in parsed ? parsed.error : null;
  };
  const fixture = backendPolicy();
  const agent0 = fixture.agents[0];

  it("takes the backend's policy as it is, every section", () => {
    const parsed = parsePolicy(fixture);
    expect("policy" in parsed && parsed.policy).toEqual(fixture);
    const compiled = compile(fixture);
    expect(compiled.detect.contains.length + compiled.tools.contains.length).toBe(fixture.agents.reduce((n, a) => n + a.ua.length, 0));
    expect(compiled.access?.blocked.size).toBe(fixture.access?.blocked.length);
    expect(compiled.verification?.signers.size).toBe(fixture.verification?.signers.length);
    expect(compiled.signerHosts).toContain("chatgpt.com");
  });

  it("rejects, whole, a policy that breaks any rule", () => {
    const bad: [string, unknown][] = [
      ["no policy", null],
      ["another schema", { ...fixture, schemaVersion: 1 }],
      ["an unknown mode", { ...fixture, mode: "everything" }],
      ["an empty needle (it would match every client)", { ...fixture, agents: [{ ...agent0, ua: [""] }] }],
      ["an uppercase needle (it could never match)", { ...fixture, agents: [{ ...agent0, ua: ["GPTBot"] }] }],
      ["an unknown agent kind", { ...fixture, agents: [{ ...agent0, kind: "robot" }] }],
      ["a pattern that isn't a regular expression", { ...fixture, patterns: { ...fixture.patterns, botLike: "(" } }],
      ["a file action this worker doesn't know", { ...fixture, content: content({ files: [{ path: "/a", action: "teleport", contentType: "text/plain", version: "" }] as never }) }],
      ["a serve base that isn't a URL", { ...fixture, content: content({ serveBaseUrl: "not a url" }) }],
      ["a proxied path that isn't a path", { ...fixture, content: content({ proxies: [{ path: "mcp", methods: { POST: "https://api.dedica.test/mcp" } }] }) }],
      ["a missing section (null is how a policy says none)", (({ access: _, ...rest }: PolicyDoc) => rest)(fixture)],
      ["an unusable age limit on identity data", { ...fixture, verification: { ...fixture.verification!, maxAgeSeconds: 0 } }],
      ["a TTL that isn't a number", { ...fixture, ttlSeconds: "30" }],
    ];
    for (const [why, raw] of bad) expect(rejected(raw), why).not.toBeNull();
  });

  it("serves nothing while the policy is rejected", async () => {
    const h = harness({ policy: { ...policy(), mode: "everything" } as never, serve: () => markdown() });
    await h.worker.policies.refresh(env);
    expect(h.worker.policies.policy).toBeNull();
    const res = await h.worker.fetch(get("/pricing.md", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
    expect(await res.text()).toBe("origin page");
    expect(serveCalls(h.calls)).toHaveLength(0);
  });

  it("ignores an IP range that isn't a CIDR, so one vendor's odd entry can't switch the worker off", () => {
    const v = { ...fixture.verification!, ipSets: { "openai-gptbot": { cidrs: ["nonsense", "20.171.207.0/24"], fetchedAt: "2026-11-01T00:00:00Z" } } };
    expect(compile({ ...fixture, verification: v }).verification?.ipSets.get("openai-gptbot")?.cidrs).toHaveLength(1);
  });

  it("clamps the TTL to 5–300 s", async () => {
    const ttl = (ttlSeconds: number) => {
      const parsed = parsePolicy({ ...fixture, ttlSeconds });
      return "policy" in parsed ? parsed.policy.ttlSeconds : null;
    };
    expect(ttl(0)).toBe(5);
    expect(ttl(86_400)).toBe(300);

    const t = 0;
    const h = harness({ policy: policy({ ttlSeconds: 0 }), now: () => t });
    const ctx = new FakeCtx();
    for (const path of ["/a.md", "/b.md", "/c.md"]) await h.worker.fetch(get(path, { "user-agent": GPTBOT_UA }), env, ctx);
    expect(h.calls.filter((c) => new URL(c.url).pathname === "/api/v1/middleware/policy/")).toHaveLength(1);
  });
});

describe("user agent length", () => {
  it("matches only the first 512 characters, so a padded user agent can't reach a pattern", async () => {
    const h = harness({ serve: () => markdown() });
    await h.worker.policies.refresh(env);
    const padded = `Mozilla/5.0 ${"x".repeat(600)} GPTBot/1.2`;
    const res = await h.worker.fetch(get("/pricing", { "user-agent": padded, "sec-fetch-mode": "navigate" }), env, new FakeCtx());
    expect(await res.text()).toBe("origin page");
    expect(serveCalls(h.calls)).toHaveLength(0);
  });
});
