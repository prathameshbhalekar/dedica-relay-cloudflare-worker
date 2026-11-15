# Dedica middleware: Cloudflare Worker (reference implementation)

One implementation of the [Dedica middleware protocol v2](../README.md). Use it if your site is on
Cloudflare; otherwise implement the protocol in your own stack. Dedica treats every middleware the same.

What it does:

- serves `/.well-known/dedica.json` and sends a heartbeat every 5 minutes (cron);
- fetches your site's policy from Dedica (cached ~30 s) and recognises AI agents;
- in `autopilot` mode, serves agent versions of your pages (`/pricing.md`, or the page itself for a
  detected agent or `Accept: text/markdown`) and Dedica-managed files (`/llms.txt`, ...) from Dedica, serves
  discovery files (`/openapi.json`, `/.well-known/ard.json`, ...) only where your origin has none, and
  proxies `/ask` (GET, and NLWeb POST) and `/mcp` once Dedica enables them. Your origin's own responses
  (404s included) are always passed through untouched. In `report` mode it passes everything through;
- reports page loads (people, agents and bots) to Dedica in batches (protocol section 7, see below).

**Fail-safe:** people, browsers and search engines always get your normal page; every call to Dedica
has a timeout; anything unexpected (Dedica slow, down, no content for a path) falls back to your origin.

- API calls and a page's sub-requests are never sent to Dedica: requests with `Authorization`, a cookie,
  `Range`, `Upgrade` or `X-Requested-With`, a browser `fetch()`, a JSON `Accept`, or a static file always get
  your origin's answer directly.
- The agent version of a normal page URL waits at most 1.5 s for Dedica. When a call to Dedica fails, every
  other request still waiting on it is released to your origin at once, and Dedica is left alone for 15 s.
- When the worker has just started, every request waits for the policy (one fetch shared by all, at most 4 s), so a
  new isolate answers the same as a warm one. If the policy doesn't come, your origin answers and Dedica is left
  alone for 15 s, during which nothing waits; while Dedica stays down, one such wait can recur every 15 s. Once a
  policy is loaded it is refreshed in the background and nothing waits.
- Dedica can hand any request back to your origin (`x-dedica-content-fallback: origin`).
- A malformed policy changes nothing: a policy that fails the worker's check (`src/policy/schema.ts`, SPEC.md 3.2.4)
  is ignored whole, and your origin answers everything. The cache TTL is kept to 5–300 s. In `report` mode nothing is
  served or blocked, whatever the policy says.
- **Kill switch:** set the variable `DEDICA_DISABLED=1` and the worker passes every request straight to your
  origin, untouched and unreported, with no calls to Dedica. `/__dedica/status` shows `"disabled": true`.

## Agent Access

The policy names every known client once, in its `agents` catalog (key, kind, user-agent needles, IP sets, signing
host). With that, the worker:

- **verifies who a bot is**, in every mode, when the policy carries `verification` (`src/identity/`): a user agent naming a bot is checked against the IP
  ranges its vendor publishes, and a Web Bot Auth signature (RFC 9421, Ed25519) against the signing agent's keys. Each
  event reports `verified`, `claimed`, `impersonator` or `unknown` and the agent it names. The client IP is used only
  in memory and is never reported. Ranges older than the policy's `maxAgeSeconds` prove nothing (`claimed`);
- **blocks** the agents the site blocks (`access.blocked`, by key), in `autopilot` and only while the policy carries
  `access` (`src/decide/access.ts`): impersonators (if the site blocks them), search engines and previews blocked by name, then AI
  agents and tools by user agent (never a search engine, never a browser navigation), then agents proven by a
  signature. Each gets `403 Not available to this client.`, reported with `block_rule`. Files are answered first,
  so a blocked crawler can still read robots.txt. The same rules run on the paths proxied to Dedica (`/ask`, `/mcp`),
  where a blocked bot gets a JSON `403` (`QUERY_FORBIDDEN`) and nothing is sent to Dedica. Nothing is exempt by user
  agent or header: `X-Dedica-Origin-Fetch` only keeps Dedica's content away from the crawler, and a blocked bot sending
  it still gets the 403. Dedica's own clients are simply never on a block list;
- **path rules** (`access.routes`): `block` answers detected AI agents 403 on a path (and its `.md`, and `/ask` or
  `/mcp`), `passthrough` leaves the path to your origin with no agent version. Exact beats prefix, a longer prefix a
  shorter one, slashes normalised; a rule this worker doesn't understand is skipped;
- **verifies signatures strictly**: `tag="web-bot-auth"`, both `created` and `expires`, and coverage of `@authority`
  and `signature-agent` are required, so a signature can't be replayed on another site or forever;
- robots.txt needs nothing new: Dedica serves the whole file (your own rules, then the groups for blocked bots) as an
  ordinary `proxy` file, and your origin's file answers whenever Dedica has none.

## Traffic reporting

The worker reports every page load to Dedica, from people, AI agents and bots alike (`src/analytics.ts`), so Dedica can
show how much of your traffic is agents. Static files, a page's sub-requests (images, scripts, XHR) and prefetches are
not reported, and neither is Dedica's own crawler.

Events are batched per worker instance and sent in the background as NDJSON to `/api/v1/middleware/events/`: at 1000
events, or 5 seconds after the first. A batch Dedica can't take right now is retried with the next one (up to 5000
events). Reporting never delays or changes a response.

What's in an event: time, method, host, path, status, latency, what the worker did (`outcome`), whether Dedica served
it, the recognised agent, the user agent, the referer's origin and path, the country, a few request headers
(`accept`, `accept-language`, `sec-fetch-*`) and only the attribution query parameters (`utm_*`, `ref`, `source`). **Never** an IP address, cookies, the full query string or the token: a visitor is
a daily pseudonym (SHA-256 of IP, user agent, day and a secret salt). Set the salt (any long random string) with
`npx wrangler secret put DEDICA_SALT`; without it no visitor pseudonym is sent at all.

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
| `DEDICA_SALT` | optional **secret**: salt for the visitor pseudonym (without it, none is sent) |
| `DEDICA_DISABLED` | optional kill switch: `1` and the worker only passes traffic through |

Logs are prefixed `[dedica]` (`npx wrangler tail`).

## Develop

```bash
npm install
npm run typecheck
npm test            # vitest, in Node; Dedica and the origin are fakes
echo 'DEDICA_MIDDLEWARE_TOKEN=dm_...' > .dev.vars
npx wrangler dev --var DEDICA_SITE_ID:<site id> --var DEDICA_API_URL:http://localhost:8000
```

How it fits together (SPEC.md describes the behaviour; each step there is named as in `decide/decide.ts`):

```
request -> worker.ts      built-in endpoints (status, kill switch, well-known), then for everything else:
        -> policy/        store.ts (cache, back-off) -> schema.ts (strict check) -> compile.ts (indexes, once)
        -> request/       facts.ts (what the request is) + classify.ts (who the client looks like, once)
        -> decide/        decide.ts: the ordered steps -> a Decision, with no network calls
                          access.ts: Agent Access rules (identity/ works out who a bot really is, lazily)
        -> execute.ts     carries the decision out: dedica/ (serve, proxy, circuit breaker) or the origin
        -> report/        event.ts + reporter.ts (batched in the background)
```

`dedica/client.ts` is the only code that builds requests to Dedica. `protocol.ts` holds the names, time limits and
size limits; `config.ts` the variables. There are no runtime dependencies.

`test/policy.fixture.json` is the backend's real policy, with something in every section: refresh it with
`npm run sync-fixture` after regenerating it in the backend (its test checks it still matches what Dedica builds).
`test/decide.test.ts` pins the order of SPEC section 6, one row per step.
