/**
 * The order of SPEC.md section 6, one row per step, against `decide` alone: no Dedica, no origin, no fetch fakes.
 * Each row names the step letter it pins down.
 */

import { describe, expect, it } from "vitest";
import { decide } from "../src/decide/decide";
import type { Decision } from "../src/decide/decision";
import { compile } from "../src/policy/compile";
import type { PolicyDoc } from "../src/policy/schema";
import { requestContext } from "../src/request/context";
import { requestFacts } from "../src/request/facts";
import { API, BROWSER_UA, GOOGLEBOT_UA, GPTBOT_UA, access, browserHeaders, content, env, get, policy } from "./helpers";

const MCP = `${API}/api/v1/middleware/query/mcp`;

const autopilot = policy({
  content: content({
    files: [
      { path: "/llms.txt", action: "proxy", contentType: "text/plain; charset=utf-8", version: "f7" },
      { path: "/openapi.json", action: "fallback", contentType: "application/json", version: "" },
    ],
    proxies: [
      { path: "/mcp", methods: { POST: MCP } },
      { path: "/offsite", methods: { POST: "https://elsewhere.example/mcp", GET: "https://elsewhere.example/mcp" } },
    ],
  }),
});
const blocking = policy({
  ...autopilot,
  access: access({
    blocked: ["gptbot"],
    routes: [
      { id: "r1", kind: "prefix", path: "/private", action: "block" },
      { id: "r2", kind: "exact", path: "/legacy", action: "passthrough" },
    ],
  }),
});

const agent = { "user-agent": GPTBOT_UA };
const post = (path: string, headers: Record<string, string> = agent) => get(path, headers, { method: "POST", body: "{}" });

interface Row {
  step: string;
  request: Request;
  policy: PolicyDoc | null;
  expected: Partial<Decision> & { do: Decision["do"] };
  path?: string;
}

const rows: Row[] = [
  { step: "5: Dedica's crawler gets the origin, unreported", request: get("/llms.txt", { "x-dedica-origin-fetch": "1" }), policy: autopilot, expected: { do: "origin", report: false } },
  { step: "5: ...unless it is blocked", request: get("/llms.txt", { ...agent, "x-dedica-origin-fetch": "1" }), policy: blocking, expected: { do: "block", rule: "crawler", json: false } },
  { step: "b: a proxied path goes to Dedica", request: post("/mcp"), policy: autopilot, expected: { do: "proxy" } },
  { step: "b: a blocked bot on a proxied path gets a JSON 403", request: post("/mcp"), policy: blocking, expected: { do: "block", rule: "crawler", json: true } },
  { step: "b->c: a target off Dedica's origin is not proxied", request: post("/offsite"), policy: autopilot, expected: { do: "origin", outcome: "origin" } },
  { step: "c: any other POST goes to the origin", request: post("/pricing"), policy: autopilot, expected: { do: "origin", outcome: "origin" } },
  { step: "a: report mode serves nothing", request: get("/llms.txt", agent), policy: policy({ ...autopilot, mode: "report" }), expected: { do: "origin" } },
  { step: "a: no policy serves nothing", request: get("/llms.txt", agent), policy: null, expected: { do: "origin" } },
  { step: "e: a proxy artifact, for a person too", request: get("/llms.txt", browserHeaders), policy: autopilot, expected: { do: "serve", outcome: "artifact" }, path: "/llms.txt" },
  { step: "e: an artifact before the block rules", request: get("/llms.txt", agent), policy: blocking, expected: { do: "serve", outcome: "artifact" } },
  { step: "e: a fallback artifact", request: get("/openapi.json", agent), policy: autopilot, expected: { do: "fallback" } },
  { step: "e: a file's own version, else the policy's", request: get("/llms.txt", agent), policy: autopilot, expected: { do: "serve", doc: { version: "f7" } } as never },
  { step: "f: a blocked agent", request: get("/pricing", agent), policy: blocking, expected: { do: "block", rule: "crawler", json: false } },
  { step: "f: a route that blocks agents, and its .md", request: get("/private/a.md", { "user-agent": "claudebot" }), policy: blocking, expected: { do: "block", rule: "route" } },
  { step: "g: a passthrough route, and its .md", request: get("/legacy.md", { "user-agent": "claudebot" }), policy: blocking, expected: { do: "origin", outcome: "origin" } },
  { step: "h: a search engine keeps the person's page, at a normal URL too", request: get("/pricing", { "user-agent": GOOGLEBOT_UA }), policy: autopilot, expected: { do: "origin", outcome: "human_page" } },
  { step: "h: a search engine keeps the person's page at .md", request: get("/pricing.md", { "user-agent": GOOGLEBOT_UA }), policy: autopilot, expected: { do: "origin", outcome: "human_page" } },
  { step: "i: an explicit .md, shared", request: get("/pricing.md", agent), policy: autopilot, expected: { do: "serve", outcome: "twin" }, path: "/pricing.md" },
  { step: "i: an excluded page's .md", request: get("/admin/x.md", agent), policy: policy({ ...autopilot, content: { ...autopilot.content!, excludePaths: ["/admin"] } }), expected: { do: "origin" } },
  { step: "j: an agent gets the agent version", request: get("/pricing", agent), policy: autopilot, expected: { do: "serve", outcome: "negotiated" }, path: "/pricing" },
  { step: "j: so does Accept: text/markdown", request: get("/pricing", { "user-agent": BROWSER_UA, accept: "text/markdown" }), policy: autopilot, expected: { do: "serve", outcome: "negotiated" } },
  { step: "j: never an API call (a cookie)", request: get("/pricing", { ...agent, cookie: "s=1" }), policy: autopilot, expected: { do: "origin" } },
  { step: "j: never a search engine", request: get("/pricing", { "user-agent": GOOGLEBOT_UA, accept: "text/markdown" }), policy: autopilot, expected: { do: "origin" } },
  { step: "j: never with negotiation off", request: get("/pricing", agent), policy: policy({ ...autopilot, content: { ...autopilot.content!, negotiate: false } }), expected: { do: "origin" } },
  { step: "k: a person gets the origin", request: get("/pricing", browserHeaders), policy: autopilot, expected: { do: "origin", outcome: "origin" } },
];

describe("decide: SPEC section 6, in order", () => {
  it.each(rows)("$step", async ({ request, policy: p, expected, path }) => {
    const decision = await decide(requestContext(requestFacts(request), env, p && compile(p), Date.now));
    expect(decision).toMatchObject(expected);
    if (path) expect(decision).toMatchObject({ doc: { path } });
  });

  it("serves shared copies of public files and private copies of agent versions", async () => {
    const at = async (request: Request) => decide(requestContext(requestFacts(request), env, compile(autopilot), Date.now));
    expect(await at(get("/pricing.md", agent))).toMatchObject({ doc: { shared: true, category: "public" } });
    expect(await at(get("/pricing", agent))).toMatchObject({ doc: { shared: false, category: "eligible", timeoutMs: 1500 } });
  });
});
