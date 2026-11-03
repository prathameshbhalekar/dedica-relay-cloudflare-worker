import { describe, expect, it } from "vitest";

import { TRANSMITTER } from "../src/env";
import { Server } from "../src/serve";
import {
  API,
  FakeCtx,
  GOOGLEBOT_UA,
  GPTBOT_UA,
  browserHeaders,
  env,
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
    expect(await res.json()).toEqual({ site_id: env.DEDICA_SITE_ID, middleware: "cloudflare-worker", version: "1.0.0" });
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
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ middleware: "cloudflare-worker", version: "1.0.0" });
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
    expect(calls).toHaveLength(0);
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

describe("query routes", () => {
  it("pass /mcp and /ask through while the policy has no query settings", async () => {
    const { edge, originCalls } = harness();
    const res = await edge.fetch(get("/mcp", { "content-type": "application/json" }, { method: "POST", body: "{}" }), env, new FakeCtx());
    expect(await res.text()).toBe("origin page");
    expect(originCalls).toHaveLength(1);
  });

  it("proxy /mcp to Dedica when enabled, only to Dedica's origin", async () => {
    const query = { askPath: "/ask", mcpPath: "/mcp", baseUrl: `${API}/`, enabled: { mcp: true, ask: false } };
    const { edge, calls, originCalls } = harness({ policy: policy({ query }) });
    // The fake answers anything that is not policy/serve with 500, which the proxy relays.
    const res = await edge.fetch(get("/mcp", { "content-type": "application/json", cookie: "secret" }, { method: "POST", body: "{}" }), env, new FakeCtx());
    expect(res.status).toBe(500);
    const proxied = calls.find((c) => c.url === `${API}/mcp`);
    expect(proxied).toBeDefined();
    expect((proxied?.init?.headers as Headers).get("cookie")).toBeNull();
    expect((proxied?.init?.headers as Headers).get("x-dedica-middleware-token")).toBe("dm_test");
    expect(originCalls).toHaveLength(0);

    const ask = await edge.fetch(get("/ask?q=hi"), env, new FakeCtx());
    expect(await ask.text()).toBe("origin page");

    const { edge: other } = harness({ policy: policy({ query: { ...query, baseUrl: "https://evil.example/" } }) });
    const refused = await other.fetch(get("/mcp", {}, { method: "POST", body: "{}" }), env, new FakeCtx());
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { jsonrpc: string }).jsonrpc).toBe("2.0");
  });

  it("joins Dedica's query base URL (no trailing slash) with /mcp and /ask, keeping the query string", async () => {
    // The shape Dedica's policy sends (mcp_gateway McpQuerySelector.settings_get).
    const query = { askPath: "/ask", mcpPath: "/mcp", baseUrl: `${API}/api/v1/middleware/query`, enabled: { mcp: true, ask: true }, requestsPerMinute: 30 };
    const { edge, calls, originCalls } = harness({ policy: policy({ query }) });
    await edge.fetch(get("/mcp", { "content-type": "application/json" }, { method: "POST", body: "{}" }), env, new FakeCtx());
    await edge.fetch(get("/ask?q=how+much"), env, new FakeCtx());
    expect(calls.map((c) => c.url)).toEqual(expect.arrayContaining([`${API}/api/v1/middleware/query/mcp`, `${API}/api/v1/middleware/query/ask?q=how+much`]));
    expect(originCalls).toHaveLength(0);
  });

  it("rate-limits query visitors and rejects wrong methods", async () => {
    const query = { askPath: "/ask", mcpPath: "/mcp", baseUrl: `${API}/`, requestsPerMinute: 1 };
    const { edge } = harness({ policy: policy({ query }) });
    const req = () => get("/mcp", { "cf-connecting-ip": "1.2.3.4" }, { method: "POST", body: "{}" });
    await edge.fetch(req(), env, new FakeCtx());
    const limited = await edge.fetch(req(), env, new FakeCtx());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect((await edge.fetch(get("/mcp"), env, new FakeCtx())).status).toBe(405);
  });
});

describe("entry module", () => {
  it("exports only the default handler (Workers treats other exports as entrypoints)", async () => {
    const mod = await import("../src/index");
    expect(Object.keys(mod)).toEqual(["default"]);
  });
});
