# Dedica middleware: Cloudflare Worker (reference implementation)

One implementation of the [Dedica middleware protocol v1](../README.md). Use it if your site is on
Cloudflare; otherwise implement the protocol in your own stack. Dedica treats every middleware the same.

What it does:

- serves `/.well-known/dedica.json` and sends a heartbeat every 5 minutes (cron);
- fetches your site's policy from Dedica (cached ~30 s) and recognises AI agents;
- in `autopilot` mode, serves agent versions of your pages (`/pricing.md`, or the page itself for a
  detected agent or `?mode=agent`) and Dedica-managed files (`/llms.txt`, ...) from Dedica, serves
  discovery files (`/openapi.json`, `/.well-known/ard.json`, ...) only where your origin has none, gives
  agents a markdown body on your 404s, and proxies `/ask` (GET, and NLWeb POST) and `/mcp` once Dedica
  enables them. In `report` mode it passes everything through.

**Fail-safe:** people, browsers and search engines always get your normal page; every call to Dedica
has a timeout; anything unexpected (Dedica slow, down, no content for a path) falls back to your origin.

## Install

### One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/prathameshbhalekar/dedica-relay-cloudflare-worker)

1. In Dedica, start onboarding and create a middleware token. Note the token (shown once) and the site id.
2. Click the button. Cloudflare copies this worker into your GitHub/GitLab account and asks for
   `DEDICA_SITE_ID`, `DEDICA_API_URL` and the `DEDICA_MIDDLEWARE_TOKEN` secret, then builds and deploys it.
3. In the Cloudflare dashboard, add a route for the worker in front of your site (e.g. `example.com/*`).
4. Run the middleware check in Dedica.

The button deploys from the public mirror
[`dedica-relay-cloudflare-worker`](https://github.com/prathameshbhalekar/dedica-relay-cloudflare-worker), which is
this directory pushed as its own repo (the button needs a public repo whose root is the worker). Edit the worker
here, commit, then update the mirror with `middleware/sync-cloudflare-worker-mirror.sh` (it pushes a snapshot of
this directory at `HEAD`, never the monorepo's history).

Secrets the button asks for come from `.dev.vars.example`; the descriptions it shows come from `cloudflare.bindings`
in `package.json`.

### By hand

1. In Dedica, start onboarding, then create a middleware token
   (`POST /api/v1/onboarding/middleware/token/`). It returns `token` (shown once) and `site_id`.
2. Deploy to your Cloudflare account:

   ```bash
   npm install
   # set DEDICA_SITE_ID (and DEDICA_API_URL if needed) in wrangler.toml
   npx wrangler secret put DEDICA_MIDDLEWARE_TOKEN   # paste the token
   npx wrangler deploy
   ```

3. Add a route so it runs in front of your site (e.g. `example.com/*`).
4. Run the middleware check in Dedica (the first policy fetch or heartbeat marks it live).

`GET /__dedica/status` on your domain shows whether the worker is configured (no secrets).

| Variable | |
|---|---|
| `DEDICA_SITE_ID` | your site id (var) |
| `DEDICA_API_URL` | Dedica's API (var) |
| `DEDICA_MIDDLEWARE_TOKEN` | **secret** (`wrangler secret put`) |
| `DEDICA_QUERY_ORIGIN` | optional: the only origin `/ask`/`/mcp` may be proxied to (defaults to `DEDICA_API_URL`'s) |
| `DEDICA_POLICY_URL` | optional: policy URL override (testing) |

Logs are prefixed `[dedica]` (`npx wrangler tail`).

## Develop

```bash
npm install
npm run typecheck
npm test            # vitest, in Node; Dedica and the origin are fakes
echo 'DEDICA_MIDDLEWARE_TOKEN=dm_...' > .dev.vars
npx wrangler dev --var DEDICA_SITE_ID:<site id> --var DEDICA_API_URL:http://localhost:8000
```

`src/`: `index.ts` (entry: default handler only), `edge.ts` (request order, heartbeat), `policy.ts` (cache and backoff), `detect.ts` (agent
detection), `serve.ts` (serving from Dedica), `query.ts` (`/ask`, `/mcp`), `env.ts`, `types.ts`.
`test/policy.fixture.json` is a real policy from the backend (the backend tests check it still matches).
