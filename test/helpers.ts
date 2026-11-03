import fixture from "./policy.fixture.json";
import { Edge } from "../src/edge";
import type { Ctx, Env, Policy } from "../src/types";

export const API = "https://api.dedica.test";
export const SITE = "https://shop.example";

export const env: Env = {
  DEDICA_SITE_ID: fixture.siteId,
  DEDICA_API_URL: API,
  DEDICA_MIDDLEWARE_TOKEN: "dm_test",
};

export const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
export const GPTBOT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
export const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

export const browserHeaders = { "user-agent": BROWSER_UA, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

export function policy(overrides: Partial<Policy> = {}): Policy {
  // JSON imports widen tuples to arrays, so the fixture is cast through unknown.
  return { ...(structuredClone(fixture) as unknown as Policy), ...overrides };
}

export class FakeCtx implements Ctx {
  pending: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise.catch(() => {}));
  }
  passThroughOnException(): void {}
  async drain(): Promise<void> {
    await Promise.all(this.pending);
  }
}

export interface Call {
  url: string;
  init?: RequestInit;
}

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** An Edge whose Dedica and origin calls are fakes. Dedica's policy is `current`, served by default. */
export function harness(options: { policy?: Policy | null; serve?: Handler; now?: () => number } = {}) {
  const calls: Call[] = [];
  const originCalls: Request[] = [];
  const state = { policy: options.policy === undefined ? policy() : options.policy, policyStatus: 200 };
  const edge = new Edge({
    now: options.now,
    dedicaFetch: async (input, init) => {
      calls.push({ url: input, init });
      const url = new URL(input);
      if (url.pathname === "/api/v1/middleware/policy/") {
        if (state.policyStatus !== 200) return new Response("nope", { status: state.policyStatus });
        return Response.json(state.policy);
      }
      if (url.pathname.startsWith("/api/v1/middleware/serve/")) {
        return options.serve ? options.serve(url, init) : new Response("not found", { status: 404 });
      }
      return new Response("unexpected", { status: 500 });
    },
    originFetch: async (request) => {
      originCalls.push(request);
      return new Response("origin page", { status: 200, headers: { "content-type": "text/html" } });
    },
  });
  return { edge, calls, originCalls, state };
}

export function get(path: string, headers: Record<string, string> = {}, init: RequestInit = {}): Request {
  return new Request(`${SITE}${path}`, { headers, ...init });
}

export function serveCalls(calls: Call[]): Call[] {
  return calls.filter((c) => new URL(c.url).pathname.startsWith("/api/v1/middleware/serve/"));
}

export function header(call: Call, name: string): string | undefined {
  return (call.init?.headers as Record<string, string> | undefined)?.[name];
}
