import { describe, expect, it } from "vitest";

import { detectAgent, isTraditionalBot, keepHumanPage, twinEligible } from "../src/detect";
import { BROWSER_UA, GOOGLEBOT_UA, GPTBOT_UA, browserHeaders, get, policy } from "./helpers";

const d = policy().detection;
const h = (headers: Record<string, string>) => new Headers(headers);

describe("detectAgent", () => {
  it("recognises known AI agents", () => {
    expect(detectAgent(h({ "user-agent": GPTBOT_UA }), d)).toBe(true);
    expect(detectAgent(h({ "user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)" }), d)).toBe(true);
  });

  it("never treats a search engine as an agent", () => {
    expect(detectAgent(h({ "user-agent": GOOGLEBOT_UA }), d)).toBe(false);
    expect(isTraditionalBot(GOOGLEBOT_UA.toLowerCase(), d)).toBe(true);
  });

  it("lets the longest needle win: applebot-extended is AI, applebot is search", () => {
    const extended = "Mozilla/5.0 (compatible; Applebot-Extended/0.1)";
    const plain = "Mozilla/5.0 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)";
    expect(detectAgent(h({ "user-agent": extended }), d)).toBe(true);
    expect(isTraditionalBot(extended.toLowerCase(), d)).toBe(false);
    expect(detectAgent(h({ "user-agent": plain }), d)).toBe(false);
    expect(isTraditionalBot(plain.toLowerCase(), d)).toBe(true);
  });

  it("lets exact search-engine matches veto and exact agent matches win", () => {
    const custom = { ...d, traditionalBotsExact: ["gptbot-but-search"], agentUaExact: ["quietclient"] };
    expect(detectAgent(h({ "user-agent": "gptbot-but-search" }), custom)).toBe(false);
    expect(detectAgent(h({ "user-agent": "quietclient" }), custom)).toBe(true);
  });

  it("treats a browser as a person, even a known agent's UA navigating", () => {
    expect(detectAgent(h(browserHeaders), d)).toBe(false);
    expect(detectAgent(h({ ...browserHeaders, "user-agent": `${BROWSER_UA} ChatGPT-User/1.0` }), d)).toBe(false);
  });

  it("counts automated-looking clients without fetch metadata as agents", () => {
    expect(detectAgent(h({ "user-agent": "python-httpx/0.28" }), d)).toBe(true);
    expect(detectAgent(h({ "user-agent": "python-httpx/0.28", "sec-fetch-mode": "cors" }), d)).toBe(false);
  });

  it("recognises signed agents", () => {
    expect(detectAgent(h({ "user-agent": BROWSER_UA, "signature-agent": '"https://chatgpt.com"' }), d)).toBe(true);
  });

  it("survives an invalid bot pattern", () => {
    expect(detectAgent(h({ "user-agent": "somebot" }), { ...d, botLikePattern: "(" })).toBe(false);
  });
});

describe("keepHumanPage", () => {
  it("keeps the normal page for search engines and link previews", () => {
    expect(keepHumanPage(GOOGLEBOT_UA.toLowerCase(), d, false)).toBe(true);
    expect(keepHumanPage("facebookexternalhit/1.1", d, false)).toBe(true);
    expect(keepHumanPage("slackbot-linkexpanding 1.0", d, false)).toBe(true);
  });

  it("does not for AI agents, browsers or HTTP libraries", () => {
    expect(keepHumanPage(GPTBOT_UA.toLowerCase(), d, false)).toBe(false);
    expect(keepHumanPage(BROWSER_UA.toLowerCase(), d, false)).toBe(false);
    expect(keepHumanPage("python-httpx/0.28", d, false)).toBe(false);
  });

  it("keeps it for unknown crawlers unless they ask a question", () => {
    expect(keepHumanPage("somecrawler/1.0", d, false)).toBe(true);
    expect(keepHumanPage("somecrawler/1.0", d, true)).toBe(false);
  });

  it("serves Dedica's live check the agent version at .md URLs, but never at normal page URLs", () => {
    const dedicabot = "dedicabot/0.1 (+https://getdedica.com/bot)";
    expect(keepHumanPage(dedicabot, d, false)).toBe(false);
    expect(isTraditionalBot(dedicabot, d)).toBe(true);
    expect(detectAgent(h({ "user-agent": dedicabot }), d)).toBe(false);
  });
});

describe("twinEligible", () => {
  const twins = { ...policy().twins, includePaths: ["/docs"], excludePaths: ["/docs/private"] };
  it("applies include and exclude prefixes", () => {
    expect(twinEligible("/docs/intro", twins)).toBe(true);
    expect(twinEligible("/docs", twins)).toBe(true);
    expect(twinEligible("/docsx", twins)).toBe(false);
    expect(twinEligible("/docs/private/a", twins)).toBe(false);
    expect(twinEligible("/pricing", { ...twins, includePaths: [] })).toBe(true);
  });
});
