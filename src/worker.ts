/**
 * The worker: all per-isolate state, and how each request flows through it.
 *
 *   built-in endpoints (status, kill switch, well-known, not configured)
 *   -> policy -> decide (decide/decide.ts) -> execute (execute.ts) -> report (report/)
 *
 * If this worker ever throws, Cloudflare sends the request to the origin instead of an error page.
 */

import { type Ctx, type Env, configured, disabled } from "./config";
import { ORIGIN, ORIGIN_UNREPORTED } from "./decide/decision";
import { decide } from "./decide/decide";
import { CircuitBreaker } from "./dedica/circuit";
import { DedicaClient, type FetchFn } from "./dedica/client";
import { Documents } from "./dedica/serve";
import { type Answer, execute } from "./execute";
import { PolicyStore } from "./policy/store";
import { MIDDLEWARE, SERVE_BACKOFF_MS, STATUS_PATH, VERSION, WELL_KNOWN_PATH } from "./protocol";
import { buildEvent } from "./report/event";
import { Reporter } from "./report/reporter";
import { type RequestContext, requestContext } from "./request/context";
import { requestFacts } from "./request/facts";
import { noStoreJson } from "./responses";

export interface WorkerDeps {
  /** Calls to Dedica (and nothing else). */
  dedicaFetch?: FetchFn;
  /** Calls to the customer's origin. */
  originFetch?: (request: Request) => Promise<Response>;
  now?: () => number;
  /** Waits before a traffic batch is sent (tests pass one that doesn't wait). */
  sleep?: (ms: number) => Promise<void>;
}

export type DedicaWorker = ReturnType<typeof createWorker>;

/** The worker and its per-isolate state. Tests build their own; the deployed worker uses one (index.ts). */
export function createWorker(deps: WorkerDeps = {}) {
  const now = deps.now ?? Date.now;
  const originFetch = deps.originFetch ?? ((request: Request) => fetch(request));
  const client = new DedicaClient(deps.dedicaFetch ?? ((input, init) => fetch(input, init)));
  const policies = new PolicyStore(client, now);
  const documents = new Documents(client, new CircuitBreaker(SERVE_BACKOFF_MS, now));
  const reporter = new Reporter(client, deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))));

  async function handle(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    ctx.passThroughOnException?.();
    const url = new URL(request.url);

    // 1. Read-only configuration check: no secrets, no calls to Dedica. Answers even when disabled, to show it.
    if (request.method === "GET" && url.pathname === STATUS_PATH) {
      const mode = policies.policy?.mode ?? null;
      return noStoreJson({ configured: configured(env), disabled: disabled(env), siteId: env.DEDICA_SITE_ID || null, mode, version: VERSION });
    }
    // 2. Kill switch: everything goes to the origin untouched, unreported, with no call to Dedica.
    if (disabled(env)) return originFetch(request);
    // 3. Installation proof.
    if (request.method === "GET" && url.pathname === WELL_KNOWN_PATH) {
      return noStoreJson({ site_id: env.DEDICA_SITE_ID ?? null, middleware: MIDDLEWARE, version: VERSION });
    }
    // 4. Not set up yet: pass straight through, unreported.
    if (!configured(env)) return originFetch(request);

    const startedAt = now();
    const facts = requestFacts(request);
    // Every request waits for a missing policy (at most POLICY_TIMEOUT_MS, shared by all requests waiting on it), so
    // a cold isolate answers the same as a warm one. Dedica's crawler only needs it for the block check on a read.
    const policy = facts.originFetch && !facts.read ? null : await policies.get(env, ctx);
    const rc = requestContext(facts, env, policy, now);
    const decision = await decide(rc).catch((error: unknown) => {
      console.warn(`[dedica] serving failed; using origin: ${error}`);
      return facts.originFetch ? ORIGIN_UNREPORTED : ORIGIN;
    });
    const answer = await execute(decision, rc, { client, documents, origin: originFetch });
    if (answer.report) report(rc, answer, ctx, startedAt);
    return answer.response;
  }

  /** Reports the request to Dedica in the background, batched (see report/). Never throws. */
  function report(rc: RequestContext, answer: Answer, ctx: Ctx, startedAt: number): void {
    try {
      if (!rc.facts.reportable) return;
      // The policy the isolate holds now (it may have been refreshed while the request was answered).
      const policy = policies.policy;
      ctx.waitUntil(
        rc
          .identity(policy)
          .then((identity) => {
            const client = policy ? rc.client(policy) : null;
            return buildEvent(rc.facts.request, answer.response, answer, policy, client, rc.env, startedAt, now(), identity);
          })
          .then((event) => reporter.add(event, rc.env, ctx))
          .catch((error: unknown) => console.warn(`[dedica] event report skipped: ${error}`)),
      );
    } catch (error) {
      console.warn(`[dedica] event report skipped: ${error}`);
    }
  }

  async function heartbeat(env: Env): Promise<void> {
    if (disabled(env)) {
      console.warn("[dedica] heartbeat skipped: DEDICA_DISABLED is set");
      return;
    }
    if (!configured(env)) {
      console.warn("[dedica] heartbeat skipped: DEDICA_SITE_ID, DEDICA_API_URL or DEDICA_MIDDLEWARE_TOKEN is not set");
      return;
    }
    try {
      const response = await client.heartbeat(env);
      if (!response.ok) console.warn(`[dedica] heartbeat failed: ${response.status}`);
    } catch (err) {
      console.warn(`[dedica] heartbeat request failed: ${err}`);
    }
  }

  return { fetch: handle, heartbeat, policies, reporter };
}
