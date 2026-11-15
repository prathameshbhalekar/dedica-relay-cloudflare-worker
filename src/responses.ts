/** The only responses the worker writes itself. Every other response is the origin's, unchanged, or Dedica's. */

import { TEXT } from "./protocol";

export const BLOCKED_BODY = "Not available to this client.";

/** A 403 on a page or a file. */
export function blocked(): Response {
  return new Response(BLOCKED_BODY, { status: 403, headers: { "content-type": TEXT } });
}

/** A 403 on a proxied path (`/ask`, `/mcp`), whose clients expect JSON. */
export function blockedJson(): Response {
  return Response.json({ error: "QUERY_FORBIDDEN", message: BLOCKED_BODY }, { status: 403, headers: { "cache-control": "no-store" } });
}

/** The status check and the installation proof: never cached. */
export function noStoreJson(body: unknown): Response {
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
