import { describe, expect, it } from "vitest";

import { TRANSMITTER } from "../src/env";
import { Server } from "../src/serve";
import type { Proxy } from "../src/types";
import {
  API,
  FakeCtx,
  GOOGLEBOT_UA,
  GPTBOT_UA,
  browserHeaders,
  env,
  eventBodies,
  get,
  harness,
  header,
  policy,
  serveCalls,
} from "./helpers";

const markdown = () => new Response("# Pricing\n", { status: 200, headers: { "content-type": "text/markdown; charset=utf-8", etag: '"abc"', "cache-control": "public, max-age=300" } });

describe("connectivity", () => {
  it("serves the well-known file without calling Dedica", async () => {
    const { edge, calls } = harness();
    const res = await edge.fetch(get("/.well-known/dedica.json"), env, new FakeCtx());
    expect(await res.json()).toEqual({ site_id: env.DEDICA_SITE_ID, middleware: "cloudflare-worker", version: "1.3.0" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls).toHaveLength(0);
  });

  it("reports its configuration without secrets", async () => {
    const { edge } = harness();
    const body = (await (await edge.fetch(get("/__dedica/status"), env, new FakeCtx())).json()) as Record<string, unknown>;
    expect(body.configured).toBe(true);
    expect(JSON.stringify(body)).not.toContain("dm_test");
  });

  it("sends heartbeats with its token and name", async () => {
    const { edge, calls } = harness();
    await edge.heartbeat(env);
    expect(calls[0].url).toBe(`${API}/api/v1/middleware/heartbeat/`);
    expect(header(calls[0], "x-dedica-middleware-token")).toBe("dm_test");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ middleware: "cloudflare-worker", version: "1.3.0" });
  });

  it("passes everything through when not configured", async () => {
    const { edge, calls, originCalls } = harness();
    await edge.fetch(get("/pricing.md", { "user-agent": GPTBOT_UA }), { ...env, DEDICA_MIDDLEWARE_TOKEN: "" }, new FakeCtx());
    expect(calls).toHaveLength(0);
    expect(originCalls).toHaveLength(1);
  });
});

describe("report mode", () => {
  it("fetches the policy (with its transmitter) but always lets the origin answer", async () => {
    const { edge, calls, originCalls } = harness({ policy: policy({ mode: "report", serve: null }) });
    const res = await edge.fetch(get("/pricing.md", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
    expect(await res.text()).toBe("origin page");
    expect(header(calls[0], "x-dedica-transmitter")).toBe(TRANSMITTER);
    expect(header(calls[0], "x-dedica-middleware-token")).toBe("dm_test");
    expect(serveCalls(calls)).toHaveLength(0);
    expect(originCalls).toHaveLength(1);
  });
});

describe("autopilot serving", () => {
  it("serves an explicit .md from Dedica, shared-cacheable", async () => {
    const { edge, calls } = harness({ serve: () => markdown() });
    const res = await edge.fetch(get("/pricing.md", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# Pricing\n");
    expect(res.headers.get("x-dedica-served")).toBe("1");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("etag")).toBe('"abc"');
    const call = serveCalls(calls)[0];
    expect(call.url).toBe(`${API}/api/v1/middleware/serve/pricing.md`);
    expect(header(call, "x-dedica-category")).toBe("public");
    expect(header(call, "x-dedica-version")).toBe(`v1:${policy().serve?.version}`);
  });

  it("negotiates the agent version of a page for an agent, privately cached", async () => {
    const { edge, calls } = harness({ serve: () => markdown() });
    const res = await edge.fetch(get("/pricing", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
    expect(await res.text()).toBe("# Pricing\n");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(header(serveCalls(calls)[0], "x-dedica-category")).toBe("eligible");
  });

  it("negotiates for any client that asks for text/markdown", async () => {
    const { edge } = harness({ serve: () => markdown() });
    const res = await edge.fetch(get("/pricing", { "user-agent": "curl/8.0", accept: "text/markdown" }), env, new FakeCtx());
    expect(await res.text()).toBe("# Pricing\n");
  });

  it("gives people and search engines the normal page", async () => {
    const { edge, calls } = harness({ serve: () => markdown() });
    expect(await (await edge.fetch(get("/pricing", browserHeaders), env, new FakeCtx())).text()).toBe("origin page");
    expect(await (await edge.fetch(get("/pricing", { "user-agent": GOOGLEBOT_UA }), env, new FakeCtx())).text()).toBe("origin page");
    expect(await (await edge.fetch(get("/pricing.md", { "user-agent": GOOGLEBOT_UA }), env, new FakeCtx())).text()).toBe("origin page");
    expect(serveCalls(calls)).toHaveLength(0);
  });

  it("falls back to the origin on 404, 5xx and network errors", async () => {
    for (const serve of [
      () => new Response("nf", { status: 404 }),
      () => new Response("boom", { status: 502 }),
      () => {
        throw new Error("network down");
      },
    ]) {
      const { edge, originCalls } = harness({ serve });
      const res = await edge.fetch(get("/pricing.md", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
      expect(await res.text()).toBe("origin page");
      expect(originCalls).toHaveLength(1);
    }
  });

  it("backs off serving for a while after a server error", async () => {
    let t = 0;
    const { edge, calls } = harness({ serve: () => new Response("boom", { status: 500 }), now: () => t });
    await edge.fetch(get("/a.md", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
    await edge.fetch(get("/b.md", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
    expect(serveCalls(calls)).toHaveLength(1);
    t = 16_000;
    await edge.fetch(get("/c.md", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
    expect(serveCalls(calls)).toHaveLength(2);
  });

  it("never serves Dedica's version to Dedica's own crawler", async () => {
    const { edge, calls } = harness({ serve: () => markdown() });
    const res = await edge.fetch(get("/pricing.md", { "user-agent": GPTBOT_UA, "x-dedica-origin-fetch": "1" }), env, new FakeCtx());
    expect(await res.text()).toBe("origin page");
    expect(calls).toHaveLength(0);
  });

  it("proxies managed artifacts for every visitor", async () => {
    const p = policy({ artifacts: [{ path: "/llms.txt", contentType: "text/plain; charset=utf-8", action: "proxy", version: "7" }] });
    const { edge, calls } = harness({ policy: p, serve: () => new Response(new TextEncoder().encode("# Shop\n"), { status: 200 }) }); // no content-type: the artifact's applies
    const res = await edge.fetch(get("/llms.txt", browserHeaders), env, new FakeCtx());
    expect(await res.text()).toBe("# Shop\n");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(header(serveCalls(calls)[0], "x-dedica-version")).toBe("v1:7");
  });

  it("forwards validators only for shared files and relays 304", async () => {
    const { edge, calls } = harness({ serve: () => new Response(null, { status: 304, headers: { etag: '"abc"' } }) });
    const res = await edge.fetch(get("/pricing.md", { "user-agent": GPTBOT_UA, "if-none-match": '"abc"' }), env, new FakeCtx());
    expect(res.status).toBe(304);
    expect(header(serveCalls(calls)[0], "if-none-match")).toBe('"abc"');

    const page = await edge.fetch(get("/pricing", { "user-agent": GPTBOT_UA, "if-none-match": '"html"' }), env, new FakeCtx());
    expect(await page.text()).toBe("origin page");
    expect(header(serveCalls(calls)[1], "if-none-match")).toBeUndefined();
  });

  it("refuses bodies over the cap", async () => {
    const { edge } = harness({ serve: () => new Response("x", { status: 200, headers: { "content-length": String(9 * 1024 * 1024) } }) });
    const res = await edge.fetch(get("/big.md", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
    expect(await res.text()).toBe("origin page");
  });

  it("ignores non-GET requests", async () => {
    const { edge, calls } = harness({ serve: () => markdown() });
    await edge.fetch(get("/pricing.md", { "user-agent": GPTBOT_UA }, { method: "POST", body: "x" }), env, new FakeCtx());
    // At most the policy is read (in the background); nothing is served.
    expect(calls.filter((c) => !new URL(c.url).pathname.startsWith("/api/v1/middleware/policy/"))).toHaveLength(0);
  });
});

describe("discovery files and agent extras", () => {
  const fallbackPolicy = () =>
    policy({ artifacts: [{ path: "/openapi.json", contentType: "application/json", action: "fallback", version: "3" }, { path: "/llms.txt", contentType: "text/plain", action: "proxy" }] });
  const spec = () => Response.json({ openapi: "3.1.0", from: "dedica" });

  it("serves a fallback artifact from Dedica when the origin has no such file", async () => {
    for (const origin of [new Response("missing", { status: 404 }), new Response("<html>app</html>", { status: 200, headers: { "content-type": "text/html" } })]) {
      const { edge, calls, originCalls } = harness({ policy: fallbackPolicy(), serve: () => spec(), origin: () => origin.clone() });
      const res = await edge.fetch(get("/openapi.json", browserHeaders), env, new FakeCtx());
      expect(await res.json()).toEqual({ openapi: "3.1.0", from: "dedica" });
      expect(res.headers.get("x-dedica-served")).toBe("1");
      expect(originCalls).toHaveLength(1);
      expect(header(serveCalls(calls)[0], "x-dedica-version")).toBe("v1:3");
    }
  });

  it("keeps the customer's own file at a fallback path", async () => {
    for (const origin of [Response.json({ openapi: "3.0.0", from: "customer" }), new Response(null, { status: 301, headers: { location: "/api/openapi.json" } })]) {
      const { edge, calls } = harness({ policy: fallbackPolicy(), serve: () => spec(), origin: () => origin.clone() });
      const res = await edge.fetch(get("/openapi.json", browserHeaders), env, new FakeCtx());
      expect(res.status).toBe(origin.status);
      expect(res.headers.get("x-dedica-served")).toBeNull();
      expect(serveCalls(calls)).toHaveLength(0);
    }
  });

  it("returns the origin's answer when neither has the file", async () => {
    const { edge } = harness({ policy: fallbackPolicy(), origin: () => new Response("missing", { status: 404 }) });
    const res = await edge.fetch(get("/openapi.json", browserHeaders), env, new FakeCtx());
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("missing");
  });

  it("serves the agent version of a page to anyone asking for ?mode=agent, but not to search engines", async () => {
    const { edge, calls } = harness({ serve: () => markdown() });
    const res = await edge.fetch(get("/?mode=agent", browserHeaders), env, new FakeCtx());
    expect(await res.text()).toBe("# Pricing\n");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const call = serveCalls(calls)[0];
    expect(header(call, "x-dedica-category")).toBe("eligible");
    expect(new URL(call.url).search).toBe("?mode=agent");
    expect(await (await edge.fetch(get("/?mode=agent", { "user-agent": GOOGLEBOT_UA }), env, new FakeCtx())).text()).toBe("origin page");
  });

  it("gives agents a markdown 404 and keeps the status", async () => {
    const p = policy({ artifacts: [{ path: "/llms.txt", contentType: "text/plain", action: "proxy" }] });
    const { edge } = harness({ policy: p, origin: () => new Response("<h1>Nope</h1>", { status: 404, headers: { "content-type": "text/html" } }) });
    const ctx = new FakeCtx();
    // Warm the policy (the 404 rewrite never waits for one).
    await edge.fetch(get("/llms.txt", browserHeaders), env, ctx);

    const res = await edge.fetch(get("/no-such-page", { "user-agent": "curl/8.0", accept: "text/markdown" }), env, ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("There is no page at `/no-such-page`");
    expect(body).toContain("https://shop.example/llms.txt");

    const person = await edge.fetch(get("/no-such-page", browserHeaders), env, ctx);
    expect(await person.text()).toBe("<h1>Nope</h1>");
    const google = await edge.fetch(get("/no-such-page", { "user-agent": GOOGLEBOT_UA }), env, ctx);
    expect(await google.text()).toBe("<h1>Nope</h1>");
  });
});

describe("serve target", () => {
  const server = new Server(async () => new Response());
  const p = policy();
  it("keeps paths inside the serve base", () => {
    expect(server.target(p, { path: "/docs/a.md", search: "?q=1" })?.url).toBe(`${API}/api/v1/middleware/serve/docs/a.md?q=1`);
    expect(server.target(p, { path: "//evil.example/a.md" })?.url).toBe(`${API}/api/v1/middleware/serve/evil.example/a.md`);
    expect(server.target(p, { path: "/%2e%2e/policy" })).toBeNull();
    expect(server.target(p, { path: "/a%2F..%2Fpolicy" })).toBeNull();
    expect(server.target({ ...p, serve: null }, { path: "/a.md" })).toBeNull();
  });
});

describe("policy cache", () => {
  it("reuses a fresh policy and refreshes after its TTL", async () => {
    let t = 0;
    const { edge, calls } = harness({ now: () => t });
    const ctx = new FakeCtx();
    await edge.fetch(get("/a.md", { "user-agent": GPTBOT_UA }), env, ctx);
    await edge.fetch(get("/b.md", { "user-agent": GPTBOT_UA }), env, ctx);
    expect(calls.filter((c) => c.url.includes("/policy/"))).toHaveLength(1);
    t = 31_000;
    await edge.fetch(get("/c.md", { "user-agent": GPTBOT_UA }), env, ctx);
    await ctx.drain();
    expect(calls.filter((c) => c.url.includes("/policy/"))).toHaveLength(2);
  });

  it("does not make browsers wait for a cold policy", async () => {
    const { edge, calls, originCalls } = harness();
    const ctx = new FakeCtx();
    const res = await edge.fetch(get("/pricing", browserHeaders), env, ctx);
    expect(await res.text()).toBe("origin page");
    expect(originCalls).toHaveLength(1);
    await ctx.drain();
    expect(calls.filter((c) => c.url.includes("/policy/"))).toHaveLength(1);
  });

  it("drops the policy and backs off when the token is rejected", async () => {
    let t = 0;
    const { edge, calls, state } = harness({ now: () => t });
    state.policyStatus = 401;
    await edge.fetch(get("/a.md", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
    t = 60_000;
    await edge.fetch(get("/b.md", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
    expect(calls.filter((c) => c.url.includes("/policy/"))).toHaveLength(1);
    expect(edge.policies.policy).toBeNull();
  });

  it("ignores a policy in an unknown schema", async () => {
    const { edge, calls } = harness({ policy: { ...policy(), schemaVersion: 2 }, serve: () => markdown() });
    const res = await edge.fetch(get("/pricing.md", { "user-agent": GPTBOT_UA }), env, new FakeCtx());
    expect(await res.text()).toBe("origin page");
    expect(serveCalls(calls)).toHaveLength(0);
  });

  it("keeps serving through a Dedica outage for up to 15 minutes", async () => {
    let t = 0;
    const { edge, state } = harness({ now: () => t, serve: () => markdown() });
    const ctx = new FakeCtx();
    await edge.fetch(get("/a.md", { "user-agent": GPTBOT_UA }), env, ctx);
    state.policyStatus = 503;
    t = 10 * 60_000;
    expect(await (await edge.fetch(get("/a.md", { "user-agent": GPTBOT_UA }), env, ctx)).text()).toBe("# Pricing\n");
    t = 16 * 60_000;
    expect(await (await edge.fetch(get("/a.md", { "user-agent": GPTBOT_UA }), env, ctx)).text()).toBe("origin page");
  });
});

describe("proxied paths", () => {
  const BASE = `${API}/api/v1/middleware/query`;
  // The shape Dedica's policy sends (mcp_gateway McpQuerySelector.proxies_get).
  const ASK: Proxy = { path: "/ask", targets: { GET: `${BASE}/ask`, POST: `${BASE}/ask/nlweb` } };
  const MCP: Proxy = { path: "/mcp", targets: { POST: `${BASE}/mcp` } };

  /** A harness whose isolate already has the policy (the first request on a cold isolate passes through). */
  async function warm(proxies: Proxy[]) {
    const h = harness({ policy: policy({ proxies }) });
    await h.edge.policies.refresh(env);
    h.calls.length = 0;
    return h;
  }
  const post = (path: string, headers: Record<string, string> = {}) =>
    get(path, { "content-type": "application/json", ...headers }, { method: "POST", body: "{}" });

  it("passes everything through while the policy lists no proxies", async () => {
    const { edge, originCalls } = await warm([]);
    expect(await (await edge.fetch(post("/mcp"), env, new FakeCtx())).text()).toBe("origin page");
    expect(originCalls).toHaveLength(1);
  });

  it("sends each method to its own target, keeping the query string, and relays Dedica's answer", async () => {
    const { edge, calls, originCalls } = await warm([ASK, MCP]);
    // The fake answers anything that is not policy/serve with 500, which the proxy relays.
    const mcp = await edge.fetch(post("/mcp", { cookie: "secret" }), env, new FakeCtx());
    expect(mcp.status).toBe(500);
    await edge.fetch(get("/ask?q=how+much"), env, new FakeCtx());
    await edge.fetch(post("/ask/", { accept: "text/event-stream" }), env, new FakeCtx());
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([`POST ${BASE}/mcp`, `GET ${BASE}/ask?q=how+much`, `POST ${BASE}/ask/nlweb`]);
    const headers = calls[0].init?.headers as Headers;
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-dedica-middleware-token")).toBe("dm_test");
    expect((calls[2].init?.headers as Headers).get("accept")).toBe("text/event-stream");
    expect(originCalls).toHaveLength(0);
  });

  it("proxies any path the policy lists", async () => {
    const { edge, calls } = await warm([{ path: "/agents/search", targets: { GET: `${BASE}/search` } }]);
    await edge.fetch(get("/agents/search?q=x"), env, new FakeCtx());
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/search?q=x`]);
  });

  it("passes an unlisted method, a too-large body or a target off Dedica's origin through, body intact", async () => {
    const { edge, originCalls } = await warm([MCP, { path: "/evil", targets: { POST: "https://evil.example/x" } }]);
    expect(await (await edge.fetch(get("/mcp"), env, new FakeCtx())).text()).toBe("origin page");
    const big = "x".repeat(40_000);
    await edge.fetch(get("/mcp", {}, { method: "POST", body: big }), env, new FakeCtx());
    expect(await originCalls[1].text()).toBe(big);
    expect(await (await edge.fetch(post("/evil"), env, new FakeCtx())).text()).toBe("origin page");
  });

  it("passes through on a cold isolate (no policy yet)", async () => {
    const { edge, originCalls } = harness({ policy: policy({ proxies: [MCP] }) });
    expect(await (await edge.fetch(post("/mcp"), env, new FakeCtx())).text()).toBe("origin page");
    expect(originCalls).toHaveLength(1);
  });

  it("ignores malformed entries", async () => {
    const bad = [{ path: "mcp", targets: { POST: `${BASE}/mcp` } }, { path: "/", targets: { POST: `${BASE}/mcp` } }, { path: "/x" }] as Proxy[];
    const { edge, originCalls } = await warm(bad);
    await edge.fetch(post("/"), env, new FakeCtx());
    await edge.fetch(post("/mcp"), env, new FakeCtx());
    await edge.fetch(post("/x"), env, new FakeCtx());
    expect(originCalls).toHaveLength(3);
  });
});

describe("traffic reporting", () => {
  /** Handles requests on a warm isolate (policy loaded) and returns what was reported once the background work is done. */
  async function reported(requests: Request | Request[], options: Parameters<typeof harness>[0] = {}) {
    const h = harness({ serve: () => markdown(), ...options });
    await h.edge.policies.refresh(env);
    const ctx = new FakeCtx();
    const responses: Response[] = [];
    for (const request of Array.isArray(requests) ? requests : [requests]) responses.push(await h.edge.fetch(request, env, ctx));
    await ctx.drain();
    return { res: responses[0], events: eventBodies(h.events), raw: h.events, edge: h.edge };
  }

  const visitor = (extra: Record<string, string> = {}) => ({ ...browserHeaders, "cf-connecting-ip": "203.0.113.7", ...extra });

  it("reports an agent reading a markdown page, keeping only attribution parameters", async () => {
    const { events, raw } = await reported(
      get("/pricing.md?utm_source=chatgpt.com&email=a@b.c&ref=answer", { "user-agent": GPTBOT_UA, cookie: "session=1" }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: "GET",
      host: "shop.example",
      path: "/pricing.md",
      query: "?utm_source=chatgpt.com&ref=answer",
      status: 200,
      outcome: "twin",
      served_by_dedica: true,
      category: "public",
      client: { kind: "ai_agent", matched: "gptbot", signature_agent: null },
      mode: "autopilot",
      policy_version: policy().version,
    });
    expect(typeof events[0].id).toBe("string");
    const body = String(raw[0].init?.body);
    for (const secret of ["a@b.c", "session=1", "dm_test"]) expect(body).not.toContain(secret);
    expect(raw[0].url).toBe(`${API}/api/v1/middleware/events/`);
    expect(header(raw[0], "content-type")).toBe("application/x-ndjson");
    expect(header(raw[0], "x-dedica-middleware-token")).toBe("dm_test");
    expect(header(raw[0], "x-dedica-transmitter")).toBe(TRANSMITTER);
    expect(header(raw[0], "x-dedica-batch-id")).toBeTruthy();
  });

  it("reports a person's page load with a daily pseudonym, never the IP", async () => {
    const { events, raw } = await reported(get("/pricing", visitor({ referer: "https://chatgpt.com/c/123?q=secret" })));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "origin", served_by_dedica: false, client: { kind: "unknown" }, referer: "https://chatgpt.com/c/123" });
    expect(events[0].visitor).toMatch(/^[0-9a-f]{64}$/);
    expect((events[0].headers as Record<string, string>)["sec-fetch-dest"]).toBe("document");
    expect(String(raw[0].init?.body)).not.toContain("203.0.113.7");
  });

  it("gives the same visitor the same pseudonym, and a different salt a different one", async () => {
    const same = await reported([get("/a", visitor()), get("/b", visitor())]);
    expect(same.events[0].visitor).toBe(same.events[1].visitor);
    const h = harness();
    await h.edge.policies.refresh(env);
    const ctx = new FakeCtx();
    await h.edge.fetch(get("/a", visitor()), { ...env, DEDICA_SALT: "another" }, ctx);
    await ctx.drain();
    expect(eventBodies(h.events)[0].visitor).not.toBe(same.events[0].visitor);
  });

  it("skips static files, a page's sub-requests and prefetches", async () => {
    const { events } = await reported([
      get("/app.js", { "user-agent": GPTBOT_UA }),
      get("/logo.png", visitor({ "sec-fetch-dest": "image" })),
      get("/api/cart", visitor({ "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" })),
      get("/next-page", visitor({ "sec-purpose": "prefetch" })),
    ]);
    expect(events).toHaveLength(0);
  });

  it("reports the agent version, a search engine's normal page, a managed file, /mcp and the agent 404", async () => {
    expect((await reported(get("/pricing", { "user-agent": GPTBOT_UA }))).events[0]).toMatchObject({ outcome: "negotiated", category: "eligible" });
    expect((await reported(get("/pricing.md", { "user-agent": GOOGLEBOT_UA }))).events[0]).toMatchObject({
      outcome: "human_page",
      client: { kind: "bot", matched: "googlebot" },
    });
    const llms = await reported(get("/llms.txt", visitor()), {
      policy: policy({ artifacts: [{ path: "/llms.txt", contentType: "text/plain", action: "proxy" }] }),
      serve: () => new Response("# llms", { status: 200, headers: { "content-type": "text/plain" } }),
    });
    expect(llms.events[0]).toMatchObject({ outcome: "artifact", served_by_dedica: true });
    const mcp = await reported(get("/mcp", { "content-type": "application/json", "user-agent": "claude-user" }, { method: "POST", body: "{}" }), {
      policy: policy({ proxies: [{ path: "/mcp", targets: { POST: `${API}/api/v1/middleware/query/mcp` } }] }),
    });
    expect(mcp.events[0]).toMatchObject({ method: "POST", path: "/mcp", outcome: "proxied", served_by_dedica: true });
    const missing = await reported(get("/nope", { "user-agent": GPTBOT_UA }), {
      serve: () => new Response("nf", { status: 404 }),
      origin: () => new Response("missing", { status: 404 }),
    });
    expect(missing.events[0]).toMatchObject({ outcome: "agent_404", status: 404 });
  });

  it("sends the events of a few seconds in one batch", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness({ serve: () => markdown(), sleep: () => gate });
    await h.edge.policies.refresh(env);
    const ctx = new FakeCtx();
    for (const request of [get("/a", visitor()), get("/b", { "user-agent": GPTBOT_UA }), get("/c", visitor())]) await h.edge.fetch(request, env, ctx);
    // Building an event hashes the visitor (async): wait until all three are buffered.
    for (let i = 0; i < 100 && h.edge.reporter.pending < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.edge.reporter.pending).toBe(3);
    expect(h.events).toHaveLength(0); // still waiting for the batch window
    release();
    await ctx.drain();
    expect(h.events).toHaveLength(1);
    expect(eventBodies(h.events).map((e) => e.path).sort()).toEqual(["/a", "/b", "/c"]);
  });

  it("reports nothing for Dedica's own crawler, the connectivity files or an unconfigured worker", async () => {
    for (const request of [
      get("/pricing", { "user-agent": GPTBOT_UA, "x-dedica-origin-fetch": "1" }),
      get("/.well-known/dedica.json", { "user-agent": GPTBOT_UA }),
      get("/__dedica/status", visitor()),
    ]) {
      expect((await reported(request)).events).toHaveLength(0);
    }
    const h = harness();
    const ctx = new FakeCtx();
    await h.edge.fetch(get("/pricing", visitor()), { ...env, DEDICA_MIDDLEWARE_TOKEN: "" }, ctx);
    await ctx.drain();
    expect(h.events).toHaveLength(0);
  });

  it("keeps a batch Dedica can't take yet and sends it with the next one", async () => {
    let status = 503;
    const { edge, raw } = await reported(get("/a", visitor()), { events: () => new Response("busy", { status }) });
    expect(edge.reporter.pending).toBe(1);
    status = 202;
    const ctx = new FakeCtx();
    await edge.fetch(get("/b", visitor()), env, ctx);
    await ctx.drain();
    expect(edge.reporter.pending).toBe(0);
    expect(eventBodies([raw[raw.length - 1]]).map((e) => e.path)).toEqual(["/a", "/b"]);
  });

  it("answers the same when reporting fails; drops a batch Dedica refuses, keeps one it couldn't reach", async () => {
    const refused = await reported(get("/pricing.md", { "user-agent": GPTBOT_UA }), { events: () => new Response("bad", { status: 400 }) });
    expect(await refused.res.text()).toBe("# Pricing\n");
    expect(refused.edge.reporter.pending).toBe(0);

    const unreachable = await reported(get("/pricing.md", { "user-agent": GPTBOT_UA }), {
      events: () => {
        throw new Error("network down");
      },
    });
    expect(await unreachable.res.text()).toBe("# Pricing\n");
    expect(unreachable.edge.reporter.pending).toBe(1);
  });
});

describe("entry module", () => {
  it("exports only the default handler (Workers treats other exports as entrypoints)", async () => {
    const mod = await import("../src/index");
    expect(Object.keys(mod)).toEqual(["default"]);
  });
});
