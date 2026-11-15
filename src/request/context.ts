/** Everything `decide` and `execute` know about one request. */

import type { Env } from "../config";
import { type Identity, identify } from "../identity/verdict";
import type { Policy } from "../policy/types";
import { clientMatch } from "./classify";
import type { RequestFacts } from "./facts";

export interface RequestContext {
  facts: RequestFacts;
  env: Env;
  /** The policy this request is handled with; null and the origin answers. */
  policy: Policy | null;
  /** Who the client really is (Agent Access), worked out at most once, and only when something needs it. */
  identity(p: Policy | null): Promise<Identity | null>;
}

export function requestContext(facts: RequestFacts, env: Env, policy: Policy | null, now: () => number): RequestContext {
  let identity: Promise<Identity | null> | null = null;
  return {
    facts,
    env,
    policy,
    identity(p) {
      const v = p?.access?.verification;
      identity ??= v
        ? identify(v, facts.request, facts.ua, clientMatch(facts.request.headers, p.detection).kind !== "unknown", now()).catch(() => null)
        : Promise.resolve(null);
      return identity;
    },
  };
}
