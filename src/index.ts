/**
 * Dedica middleware: Cloudflare Worker (reference implementation of /middleware/README.md, protocol v1).
 * How it is put together: worker.ts.
 *
 * One worker in front of your site that connects it to Dedica:
 *   - it proves it is installed: serves /.well-known/dedica.json and sends heartbeats;
 *   - it fetches your site's policy from Dedica and recognises AI agents;
 *   - in `autopilot` mode it SERVES agent-facing files from Dedica on your own domain (llms.txt,
 *     markdown versions of your pages, ...) to agents, and proxies /ask and /mcp once enabled.
 *     In `report` mode, and for every person and search engine, your site behaves exactly as before.
 *
 * SAFE BY DESIGN: every call to Dedica has a timeout, and anything unexpected falls back to your
 * origin. If Dedica is slow, down or misconfigured, your site is served as if this worker weren't there.
 */

import type { Env } from "./config";
import { createWorker } from "./worker";

// Only the default handler may be exported from this module: Workers treats other exports as entrypoints.
const worker = createWorker();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return worker.fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(worker.heartbeat(env));
  },
} satisfies ExportedHandler<Env>;
