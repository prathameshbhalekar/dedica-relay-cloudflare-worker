/** Everything `decide` and `execute` know about one request. */

import type { Env } from "../config";
import { type Identity, identify } from "../identity/verdict";
import type { Policy } from "../policy/compile";
import { type Client, classify } from "./classify";
import type { RequestFacts } from "./facts";

export interface RequestContext {
  facts: RequestFacts;
  env: Env;
  /** The policy this request is handled with; null and the origin answers. */
  policy: Policy | null;
  /** Who the client looks like under a policy (worked out once per policy). */
  client(p: Policy): Client;
  /** Who the client really is (Agent Access), worked out at most once, and only when something needs it. */
  identity(p: Policy | null): Promise<Identity | null>;
}

export function requestContext(facts: RequestFacts, env: Env, policy: Policy | null, now: () => number): RequestContext {
  const clients = new Map<Policy, Client>();
  let identity: Promise<Identity | null> | null = null;
  const ctx: RequestContext = {
    facts,
    env,
    policy,
    client(p) {
      let c = clients.get(p);
      if (!c) {
        c = classify(facts, p);
        clients.set(p, c);
      }
      return c;
    },
    identity(p) {
      identity ??= p?.verification
        ? identify(p, facts.request, facts.ua, ctx.client(p).reason !== null, now()).catch(() => null)
        : Promise.resolve(null);
      return identity;
    },
  };
  return ctx;
}
