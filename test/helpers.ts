import fixture from "./policy.fixture.json";
import type { Ctx, Env } from "../src/config";
import { createWorker } from "../src/worker";
import type { AccessDoc, ContentDoc, PolicyDoc } from "../src/policy/schema";

export const API = "https://api.dedica.test";
export const SITE = "https://shop.example";

export const env: Env = {
  DEDICA_SITE_ID: "00000000-0000-4000-8000-000000000001",
  DEDICA_API_URL: API,
  DEDICA_MIDDLEWARE_TOKEN: "dm_test",
  DEDICA_SALT: "salt_test",
};

export const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
export const GPTBOT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
export const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

export const browserHeaders = { "user-agent": BROWSER_UA, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

/** The backend's policy, exactly as Dedica builds it (`npm run sync-fixture`). Every section has something in it. */
export function backendPolicy(): PolicyDoc {
  return structuredClone(fixture) as unknown as PolicyDoc;
}

/**
 * A neutral autopilot policy for tests: the backend's agent catalog and patterns, serving on, but no files, no
 * proxied paths, no Agent Access rules and no verification data. Tests add what they exercise.
 */
export function policy(overrides: Partial<PolicyDoc> = {}): PolicyDoc {
  const base = backendPolicy();
  return { ...base, access: null, verification: null, content: { ...base.content!, files: [], proxies: [] }, ...overrides };
}

/** The neutral policy's `content`, with overrides. */
export function content(overrides: Partial<ContentDoc> = {}): ContentDoc {
  return { ...policy().content!, ...overrides };
}

/** Agent Access rules that block nothing, with overrides. */
export function access(overrides: Partial<AccessDoc> = {}): AccessDoc {
  return { impersonators: "flag", blocked: [], routes: [], ...overrides };
}

/** A policy in report mode: nothing is served or blocked. */
export function reportPolicy(): PolicyDoc {
  return policy({ mode: "report", content: null });
}

export class FakeCtx implements Ctx {
  pending: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise.catch(() => {}));
  }
  passThroughOnException(): void {}
  /** Waits for all background work, including work queued by background work (a scheduled batch flush). */
  async drain(): Promise<void> {
    let settled = -1;
    while (settled !== this.pending.length) {
      settled = this.pending.length;
      await Promise.all(this.pending);
    }
  }
}

export interface Call {
  url: string;
  init?: RequestInit;
}

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** A worker whose Dedica and origin calls are fakes. Dedica's policy is `current`, served by default. */
export function harness(
  options: {
    policy?: PolicyDoc | null;
    serve?: Handler;
    origin?: (request: Request) => Response;
    now?: () => number;
    events?: Handler;
    /** Any other Dedica URL (proxy targets, ...). Without it they answer 500. */
    dedica?: Handler;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const calls: Call[] = [];
  const originCalls: Request[] = [];
  /** Traffic events the worker reported (kept apart from `calls`, which are serving traffic). */
  const events: Call[] = [];
  const state = { policy: options.policy === undefined ? policy() : options.policy, policyStatus: 200 };
  const worker = createWorker({
    now: options.now,
    sleep: options.sleep ?? (() => Promise.resolve()),
    dedicaFetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/api/v1/middleware/events/") {
        events.push({ url: input, init });
        return options.events ? options.events(url, init) : new Response('{"ok":true}', { status: 202 });
      }
      calls.push({ url: input, init });
      if (url.pathname === "/api/v1/middleware/policy/") {
        if (state.policyStatus !== 200) return new Response("nope", { status: state.policyStatus });
        return Response.json(state.policy);
      }
      if (url.pathname.startsWith("/api/v1/middleware/serve/")) {
        return options.serve ? options.serve(url, init) : new Response("not found", { status: 404 });
      }
      return options.dedica ? options.dedica(url, init) : new Response("unexpected", { status: 500 });
    },
    originFetch: async (request) => {
      originCalls.push(request);
      if (options.origin) return options.origin(request);
      return new Response("origin page", { status: 200, headers: { "content-type": "text/html" } });
    },
  });
  return { worker, calls, originCalls, events, state };
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

/** Every reported traffic event, across batches (each batch is NDJSON). */
export function eventBodies(events: Call[]): Record<string, unknown>[] {
  return events.flatMap((e) =>
    String(e.init?.body)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}
