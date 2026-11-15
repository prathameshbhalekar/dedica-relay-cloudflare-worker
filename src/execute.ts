/**
 * Carries out a decision. The only place that fetches from Dedica or the origin for a request, and the only place
 * that falls back from Dedica to the origin: whenever Dedica has no answer, the origin's is returned untouched.
 */

import type { BlockRule } from "./decide/access";
import type { Category, Decision, Outcome } from "./decide/decision";
import type { DedicaClient } from "./dedica/client";
import { proxy } from "./dedica/proxy";
import type { DocRequest, Documents } from "./dedica/serve";
import type { RequestContext } from "./request/context";
import { blocked, blockedJson } from "./responses";

/** How a request was answered. */
export interface Answer {
  response: Response;
  outcome: Outcome;
  category: Category;
  /** The Agent Access rule that answered 403, if any. */
  blockRule?: BlockRule;
  /** False for Dedica's own crawler, which is never reported. */
  report: boolean;
}

export interface ExecuteDeps {
  client: DedicaClient;
  documents: Documents;
  origin: (request: Request) => Promise<Response>;
}

export async function execute(decision: Decision, ctx: RequestContext, deps: ExecuteDeps): Promise<Answer> {
  const { request } = ctx.facts;
  const origin = async (outcome: Outcome = "origin", report = true): Promise<Answer> => ({
    response: await deps.origin(request),
    outcome,
    category: null,
    report,
  });

  switch (decision.do) {
    case "origin":
      return origin(decision.outcome, decision.report !== false);

    case "block":
      return { response: decision.json ? blockedJson() : blocked(), outcome: "blocked", category: null, blockRule: decision.rule, report: true };

    case "serve": {
      const response = await document(decision.doc, ctx, deps);
      return response ? { response, outcome: decision.outcome, category: decision.doc.category, report: true } : origin();
    }

    case "fallback": {
      // The origin's own file wins; else Dedica's; else the origin's answer after all.
      const own = await deps.origin(request).catch(() => null);
      if (!(own && originHasFile(own))) {
        const response = await document(decision.doc, ctx, deps);
        if (response) {
          void own?.body?.cancel().catch(() => {});
          return { response, outcome: "artifact", category: "public", report: true };
        }
      }
      return { response: own ?? (await deps.origin(request)), outcome: "artifact_origin", category: "public", report: true };
    }

    case "proxy": {
      const response = await proxy(request, decision.target, ctx.env, deps.client);
      return response ? { response, outcome: "proxied", category: null, report: true } : origin();
    }
  }
}

/** Dedica's document, or null when it has none or the call failed (logged). */
function document(doc: DocRequest, ctx: RequestContext, deps: ExecuteDeps): Promise<Response | null> {
  const baseUrl = ctx.policy?.content?.serveBaseUrl;
  if (!baseUrl) return Promise.resolve(null);
  return deps.documents.get(doc, baseUrl, ctx.env, ctx.facts.request).catch((error: unknown) => {
    console.warn(`[dedica] serving failed; using origin: ${error}`);
    return null;
  });
}

/** A real file at the origin: any redirect, or a 2xx that isn't an HTML page (a single-page app answers every path). */
function originHasFile(response: Response): boolean {
  if (response.status >= 300 && response.status < 400) return true;
  if (response.status < 200 || response.status >= 300) return false;
  return !(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
}
