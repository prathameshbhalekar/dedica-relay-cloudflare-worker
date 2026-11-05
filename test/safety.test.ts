/** The worker never gets in the way of traffic that worked before it: kill switch, fallbacks, limits, bad policies. */

import { describe, expect, it } from "vitest";

import { NEGOTIATE_TIMEOUT_MS } from "../src/env";
import { sanitizePolicy } from "../src/policy";
import fixture from "./policy.fixture.json";
import { API, FakeCtx, GPTBOT_UA, env, get, harness, policy, serveCalls } from "./helpers";

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
      const res = await h.edge.fetch(get(path, { "user-agent": GPTBOT_UA }), off, ctx);
      expect(await res.text()).toBe("origin page");
    }
    await ctx.drain();
    expect(h.calls).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(h.originCalls).toHaveLength(4);
  });

  it("still says so on the status endpoint, and skips the heartbeat", async () => {
    const h = harness();
    const body = (await (await h.edge.fetch(get("/__dedica/status"), off, new FakeCtx())).json()) as Record<string, unknown>;
    expect(body.disabled).toBe(true);
    await h.edge.heartbeat(off);
    expect(h.calls).toHaveLength(0);
  });

  it("only takes an explicit yes", async () => {
    const h = harness({ serve: () => markdown() });
    const res = await h.edge.fetch(get("/pricing.md", { "user-agent": GPTBOT_UA }), { ...env, DEDICA_DISABLED: "0" }, new FakeCtx());
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
    await h.edge.policies.refresh(env);
    const res = await h.edge.fetch(get(path, { "user-agent": "okhttp/4.12.0", ...extra }), env, new FakeCtx());
    expect(await res.text()).toBe("origin page");
    expect(serveCalls(h.calls)).toHaveLength(0);
  });

  it("still negotiates a plain agent page read", async () => {
    const h = harness({ serve: () => markdown() });
    const res = await h.edge.fetch(get("/pricing", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
    expect(await res.text()).toBe("# Pricing\n");
  });

  it("keeps explicit .md URLs for clients that send a cookie", async () => {
    const h = harness({ serve: () => markdown() });
    const res = await h.edge.fetch(get("/pricing.md", { "user-agent": GPTBOT_UA, cookie: "a=1" }), env, new FakeCtx());
    expect(await res.text()).toBe("# Pricing\n");
  });
});

describe("a slow Dedica", () => {
  it(`gives up on a negotiated page after ${NEGOTIATE_TIMEOUT_MS} ms and the origin answers`, async () => {
    const h = harness({ serve: (_, init) => hang(init) });
    await h.edge.policies.refresh(env);
    const started = Date.now();
    const res = await h.edge.fetch(get("/pricing", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
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
    await h.edge.policies.refresh(env);
    const ctx = new FakeCtx();
    const started = Date.now();
    const stalled = h.edge.fetch(get("/a.md", { "user-agent": GPTBOT_UA }), env, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.edge.fetch(get("/b.md", { "user-agent": GPTBOT_UA }), env, ctx);
    expect(await (await stalled).text()).toBe("origin page");
    expect(Date.now() - started).toBeLessThan(1_000);
    // And the backoff holds: the next request doesn't ask Dedica at all.
    await h.edge.fetch(get("/c.md", { "user-agent": GPTBOT_UA }), env, ctx);
    expect(serveCalls(h.calls)).toHaveLength(2);
  });
});

describe("Dedica can hand a request back to the origin", () => {
  it("serves the origin when Dedica answers with x-dedica-content-fallback: origin, without backing off", async () => {
    const h = harness({ serve: () => new Response("# ignored", { status: 200, headers: { "x-dedica-content-fallback": "origin" } }) });
    const ctx = new FakeCtx();
    expect(await (await h.edge.fetch(get("/a.md", { "user-agent": GPTBOT_UA }), env, ctx)).text()).toBe("origin page");
    expect(await (await h.edge.fetch(get("/b.md", { "user-agent": GPTBOT_UA }), env, ctx)).text()).toBe("origin page");
    expect(serveCalls(h.calls)).toHaveLength(2);
  });

  it("does the same for a proxied path, and the origin still gets the body", async () => {
    const target = `${API}/api/v1/middleware/query/mcp`;
    const h = harness({
      policy: policy({ proxies: [{ path: "/mcp", targets: { POST: target } }] }),
      origin: (request) => new Response(`origin saw ${request.method}`, { status: 200 }),
    });
    // The harness answers unknown Dedica paths with a 500; make the proxy target decline instead.
    const fetchFn = (h.edge as unknown as { dedicaFetch: (u: string, i?: RequestInit) => Promise<Response> }).dedicaFetch;
    (h.edge as unknown as { dedicaFetch: typeof fetchFn }).dedicaFetch = async (u, i) =>
      u.startsWith(target) ? new Response("no", { status: 200, headers: { "x-dedica-content-fallback": "origin" } }) : fetchFn(u, i);
    await h.edge.policies.refresh(env);
    const res = await h.edge.fetch(get("/mcp", { "content-type": "application/json" }, { method: "POST", body: "{}" }), env, new FakeCtx());
    expect(await res.text()).toBe("origin saw POST");
    expect(await h.originCalls[0].text()).toBe("{}");
  });
});

describe("policy validation", () => {
  it("keeps the real backend policy as it is", () => {
    expect(sanitizePolicy(fixture)).toEqual(fixture);
  });

  it("rejects a policy it can't use safely", () => {
    expect(sanitizePolicy({ ...fixture, mode: "everything" })).toBeNull();
    expect(sanitizePolicy({ ...fixture, detection: null })).toBeNull();
    expect(sanitizePolicy({ ...fixture, twins: "yes" })).toBeNull();
    expect(sanitizePolicy(null)).toBeNull();
  });

  it("drops empty needles, so they can't match every client", () => {
    const p = sanitizePolicy({ ...fixture, detection: { ...fixture.detection, agentUa: ["", "gptbot", 7], signatureAgentDomains: [""] } });
    expect(p?.detection.agentUa).toEqual(["gptbot"]);
    expect(p?.detection.signatureAgentDomains).toEqual([]);
  });

  it("serves nothing to an ordinary client when the policy has an empty agent needle", async () => {
    const bad = policy();
    bad.detection.agentUa = [""];
    bad.detection.botLikePattern = "";
    const h = harness({ policy: bad, serve: () => markdown() });
    await h.edge.policies.refresh(env);
    const res = await h.edge.fetch(get("/pricing", { "user-agent": "SomeApp/1.0" }), env, new FakeCtx());
    expect(await res.text()).toBe("origin page");
    expect(serveCalls(h.calls)).toHaveLength(0);
  });

  it("turns twins off when the suffix is empty, instead of making every URL a markdown URL", () => {
    const p = sanitizePolicy({ ...fixture, twins: { ...fixture.twins, suffix: "" } });
    expect(p?.twins.enabled).toBe(false);
  });

  it("clamps the TTL to 5–300 s", async () => {
    expect(sanitizePolicy({ ...fixture, ttlSeconds: 0 })?.ttlSeconds).toBe(5);
    expect(sanitizePolicy({ ...fixture, ttlSeconds: 86_400 })?.ttlSeconds).toBe(300);
    expect(sanitizePolicy({ ...fixture, ttlSeconds: "30" })?.ttlSeconds).toBe(30);

    const t = 0;
    const h = harness({ policy: policy({ ttlSeconds: 0 }), now: () => t });
    const ctx = new FakeCtx();
    for (const path of ["/a.md", "/b.md", "/c.md"]) await h.edge.fetch(get(path, { "user-agent": GPTBOT_UA }), env, ctx);
    expect(h.calls.filter((c) => new URL(c.url).pathname === "/api/v1/middleware/policy/")).toHaveLength(1);
  });

  it("keeps an artifact with an unknown action for the origin", async () => {
    const p = sanitizePolicy({ ...fixture, artifacts: [{ path: "/notes.md", contentType: "text/markdown", action: "teleport" }] });
    expect(p?.artifacts[0].action).toBe("passthrough");
    const h = harness({ policy: policy({ artifacts: [{ path: "/notes.md", contentType: "text/markdown", action: "teleport" as never }] }), serve: () => markdown() });
    const res = await h.edge.fetch(get("/notes.md", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
    expect(await res.text()).toBe("origin page");
  });

  it("drops a serve setting with no usable base URL", () => {
    expect(sanitizePolicy({ ...fixture, serve: { baseUrl: "not a url", version: "1" } })?.serve).toBeNull();
  });
});

describe("user agent length", () => {
  it("matches only the first 512 characters, so a padded user agent can't reach a pattern", async () => {
    const h = harness({ serve: () => markdown() });
    await h.edge.policies.refresh(env);
    const padded = `Mozilla/5.0 ${"x".repeat(600)} GPTBot/1.2`;
    const res = await h.edge.fetch(get("/pricing", { "user-agent": padded, "sec-fetch-mode": "navigate" }), env, new FakeCtx());
    expect(await res.text()).toBe("origin page");
    expect(serveCalls(h.calls)).toHaveLength(0);
  });
});
