import { describe, expect, it } from "vitest";

import { compile } from "../src/policy/compile";
import type { AgentDoc } from "../src/policy/schema";
import { classify } from "../src/request/classify";
import { requestFacts } from "../src/request/facts";
import { eligible } from "../src/util/paths";
import { BROWSER_UA, GOOGLEBOT_UA, GPTBOT_UA, browserHeaders, get, policy } from "./helpers";

const p = compile(policy());
const client = (headers: Record<string, string>, compiled = p) => classify(requestFacts(get("/pricing", headers)), compiled);
const ua = (userAgent: string) => client({ "user-agent": userAgent });

describe("classify: who wants the agent version", () => {
  it("recognises known AI agents, and names them", () => {
    expect(ua(GPTBOT_UA)).toMatchObject({ reason: "agent", agent: { key: "gptbot" }, matched: "gptbot", wantsAgentVersion: true });
    expect(ua("Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)").wantsAgentVersion).toBe(true);
  });

  it("never treats a search engine as an agent", () => {
    expect(ua(GOOGLEBOT_UA)).toMatchObject({ reason: "search", searchEngine: true, wantsAgentVersion: false });
  });

  it("lets the longest needle win: applebot-extended is AI, applebot is search", () => {
    expect(ua("Mozilla/5.0 (compatible; Applebot-Extended/0.1)")).toMatchObject({ reason: "agent", searchEngine: false });
    expect(ua("Mozilla/5.0 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)")).toMatchObject({ reason: "search", searchEngine: true });
  });

  it("matches whole user agents first, and a search engine wins a tie", () => {
    const entry = (key: string, kind: AgentDoc["kind"], uaExact: string[], needles: string[] = []): AgentDoc => ({ key, kind, ua: needles, uaExact, page: "agent" });
    const custom = compile(policy({ agents: [entry("quiet", "ai", ["quietclient"]), entry("a", "ai", [], ["twinbot"]), entry("s", "search", [], ["twinbot"])] }));
    expect(client({ "user-agent": "quietclient" }, custom)).toMatchObject({ reason: "agent", agent: { key: "quiet" } });
    expect(client({ "user-agent": "x twinbot" }, custom)).toMatchObject({ reason: "search", agent: { key: "s" } });
  });

  it("treats a browser as a person, even a known agent's UA navigating", () => {
    expect(client(browserHeaders)).toMatchObject({ reason: null, wantsAgentVersion: false });
    expect(client({ ...browserHeaders, "user-agent": `${BROWSER_UA} ChatGPT-User/1.0` }).wantsAgentVersion).toBe(false);
  });

  it("counts automated-looking clients without fetch metadata as agents", () => {
    expect(ua("python-httpx/0.28")).toMatchObject({ reason: "botlike", wantsAgentVersion: true });
    expect(client({ "user-agent": "python-httpx/0.28", "sec-fetch-mode": "cors" }).wantsAgentVersion).toBe(false);
  });

  it("never detects a tool by name: tools are only named and blockable", () => {
    expect(ua("curl/8.4.0")).toMatchObject({ reason: null, agent: null, wantsAgentVersion: false });
  });

  it("recognises signed agents", () => {
    expect(client({ "user-agent": BROWSER_UA, "signature-agent": '"https://chatgpt.com"' })).toMatchObject({ reason: "signed", signer: "chatgpt.com", wantsAgentVersion: true });
  });
});

describe("classify: who keeps the person's page", () => {
  it("search engines and link previews do", () => {
    expect(ua(GOOGLEBOT_UA).keepsHumanPage).toBe(true);
    expect(ua("facebookexternalhit/1.1").keepsHumanPage).toBe(true);
    expect(ua("slackbot-linkexpanding 1.0").keepsHumanPage).toBe(true);
  });

  it("AI agents, browsers and HTTP libraries don't", () => {
    expect(ua(GPTBOT_UA).keepsHumanPage).toBe(false);
    expect(ua(BROWSER_UA).keepsHumanPage).toBe(false);
    expect(ua("python-httpx/0.28").keepsHumanPage).toBe(false);
  });

  it("unknown crawlers do", () => {
    expect(ua("somecrawler/1.0").keepsHumanPage).toBe(true);
  });

  it("serves Dedica's live check the agent version at .md URLs, but never at normal page URLs", () => {
    const dedicabot = ua("dedicabot/0.1 (+https://getdedica.com/bot)");
    expect(dedicabot).toMatchObject({ keepsHumanPage: false, searchEngine: true, wantsAgentVersion: false });
  });
});

describe("eligible", () => {
  it("applies exclude prefixes", () => {
    expect(eligible("/docs/intro", ["/docs/private"])).toBe(true);
    expect(eligible("/docs/private", ["/docs/private"])).toBe(false);
    expect(eligible("/docs/private/a", ["/docs/private"])).toBe(false);
    expect(eligible("/docs/privatex", ["/docs/private"])).toBe(true);
  });
});
