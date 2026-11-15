# Dedica Cloudflare Worker: Behaviour Specification

Worker version **2.0.0**, Dedica middleware protocol **v2** (policy `schemaVersion` 2).

This document describes what the worker receives from Dedica, what it sends to Dedica, and how it answers every
request. It describes observable behaviour only.

Terms used throughout:

- **Origin**: the customer's site, answering exactly as it would without the worker.
- **Dedica**: the Dedica backend API.
- **Visitor**: whoever sent the request (a person's browser, a search engine, an AI agent, a script).
- **Policy**: the site's settings, fetched from Dedica (section 3.2).
- **User agent (UA)**: unless stated otherwise, the visitor's `User-Agent` header, **cut to its first 512 characters
  and lowercased**. Every match against the user agent uses this form (policy needles are lowercase).
- **Instance**: one running copy of the worker. Cloudflare may run many at once. Each instance keeps its own policy
  cache, back-off timers and unsent traffic events; nothing is shared between instances.

---

## 1. Guarantees

1. **Origin responses are never changed.** Whenever the origin answers, the visitor gets the origin's response
   exactly as the origin sent it, including errors and 404s. The origin always receives the visitor's original
   request.
2. **Anything unexpected falls back to the origin.** If Dedica is slow, down, answers with an error, has no content
   for a path, or the worker itself fails, the origin answers. The one exception is proxied paths
   (3.4): once Dedica answers there, its answer is relayed as is, error statuses included.
3. **People and search engines get the normal page.** At a normal page URL, Dedica's agent version is never served
   to a search engine, to a request carrying cookies, credentials or a range, or to a page's sub-request; a browser
   navigation gets it only if it asks for `text/markdown` or carries a recognised `Signature-Agent`.
4. **Every call to Dedica has a time limit** (section 9).
5. **A malformed policy changes nothing.** A policy that fails its check (3.2.4) is ignored entirely, so the site
   behaves as if the worker were not there. In `report` mode nothing is served or blocked, whatever the policy says.
6. **Reporting never affects a response.** Traffic events are sent in the background after the response.

---

## 2. Configuration

| Variable | Kind | Behaviour |
|---|---|---|
| `DEDICA_SITE_ID` | var | The site id. Required. |
| `DEDICA_API_URL` | var | Dedica's API base, e.g. `https://api.getdedica.com`. Trailing slashes are ignored. Required. (With only `DEDICA_POLICY_URL` set, the worker counts as configured and policy and serve calls work, but heartbeats and traffic events always fail, and proxied paths work only if `DEDICA_QUERY_ORIGIN` is set.) |
| `DEDICA_MIDDLEWARE_TOKEN` | secret | The middleware token (`dm_…`). Required. |
| `DEDICA_POLICY_URL` | var, optional | Replaces the policy URL only (testing). |
| `DEDICA_QUERY_ORIGIN` | var, optional | The only origin that proxied paths (section 3.4) may be sent to. Defaults to the origin of `DEDICA_API_URL`. |
| `DEDICA_SALT` | secret, optional | Salt for the daily visitor pseudonym in traffic events. Without it, no pseudonym is sent. |
| `DEDICA_DISABLED` | var, optional | Kill switch. `1`, `true`, `yes` or `on` (any case, surrounding spaces ignored) turn the worker off (section 6, step 2). Any other value, or unset, leaves it on. |

The worker is **configured** when it has a site id, a token, and either `DEDICA_API_URL` or `DEDICA_POLICY_URL`.

---

## 3. Communication with Dedica

### 3.1 Common to every call

Every call the worker makes to Dedica carries:

| Header | Value |
|---|---|
| `x-dedica-middleware-token` | the configured token |
| `x-dedica-transmitter` | `cloudflare-worker/2.0.0` |

Responses to policy, serve, heartbeat and event calls are never stored in Cloudflare's cache.

Policy, heartbeat and event calls follow redirects, sending the headers above to the redirect target. Serve and proxy
calls never follow redirects.

Endpoints below are relative to `DEDICA_API_URL`, except serve URLs and proxy targets, which come from the policy.

### 3.2 Policy

**Request:** `GET /api/v1/middleware/policy/` (or `DEDICA_POLICY_URL`), header `accept: application/json`, time
limit 4 s.

#### 3.2.1 How the response is handled

| Dedica answers | Effect | Next attempt no sooner than |
|---|---|---|
| 2xx with a usable policy | The policy is stored and used | when it expires |
| 401 or 403 | The stored policy is dropped immediately | 5 min |
| 408, 429 or 5xx | The stored policy is kept (within the limits of 3.2.2) | 15 s |
| Any other error status | The stored policy is dropped immediately | 15 s |
| 2xx that fails the check (3.2.4), including a `schemaVersion` other than `2` | The stored policy is dropped immediately | 60 s |
| Body that isn't JSON, network error, time limit reached | The stored policy is kept (within the limits of 3.2.2) | 15 s |

While waiting for the next attempt, no policy request is made and no request waits for one.

#### 3.2.2 Caching

- A policy is **fresh** for `ttlSeconds` after it was fetched.
- For **30 s after it expires**, it is still used as is, and a refresh starts in the background.
- **Later than that, or with no policy at all**, a request waits for a refresh (at most ~4 s), then continues with
  whatever policy is available.
- If a refresh fails, the old policy stays usable:
  - if it has `content` (autopilot): until **15 minutes** after its last successful fetch;
  - otherwise: until **30 s** after it expired.

  After that the instance has no policy and every request goes to the origin.
- Only one policy request is in flight per instance at a time. All requests waiting for a policy share it.

Consequence: a freshly started instance answers its first requests the same way a warmed-up one would, because they
wait for the policy. When Dedica is down, at most one ~4 s wait can recur every 15 s.

#### 3.2.3 Policy contents

```jsonc
{
  "schemaVersion": 2,             // must be exactly 2
  "version": "61c9d38e313cda3f",  // changes whenever what is served can; reported in events
  "ttlSeconds": 30,               // clamped to 5–300
  "mode": "autopilot",            // "report" | "autopilot"
  "agents": [                     // one entry per known client
    { "key": "gptbot", "kind": "ai",        // "ai" | "search" (engines, previews, monitors) | "tool"
      "ua": ["gptbot"], "uaExact": [],      // lowercase; substrings of / the whole lowercased UA
      "page": "agent",                      // "agent" | "human": what it gets at a .md URL (and see 4.3)
      "ipSets": ["openai-gptbot"],          // optional: verification.ipSets that prove it
      "signer": "chatgpt.com" }             // optional: the Signature-Agent host it signs with
  ],
  "patterns": {
    "botLike": "bot\\b|crawl|…",  // unknown automated clients (4.1)
    "crawler": "bot\\b|crawl|…"   // unknown crawlers that keep the person's page (4.3)
  },
  "content": {                    // null outside autopilot
    "serveBaseUrl": "https://api.getdedica.com/api/v1/middleware/serve/",
    "negotiate": true,            // agent version at the normal page URL too
    "excludePaths": [],           // path prefixes that never get an agent version
    "files": [ { "path": "/llms.txt", "action": "proxy" | "fallback", "contentType": "text/plain; charset=utf-8", "version": "…" } ],
    "proxies": [ { "path": "/mcp", "methods": { "POST": "https://api.getdedica.com/…" } } ]
  },
  "access": {                     // null unless the site's Agent Access rules are enforced
    "impersonators": "flag",      // "flag" | "block"
    "blocked": ["gptbot"],        // agent keys
    "routes": [ { "id": "…", "kind": "exact" | "prefix", "path": "/private", "action": "block" | "passthrough" } ]
  },
  "verification": {               // null: no identity verdicts
    "maxAgeSeconds": 604800,
    "ipSets": { "<set id>": { "cidrs": ["66.249.64.0/19", …], "fetchedAt": "<ISO time>" } },
    "signers": [
      { "host": "chatgpt.com", "fetchedAt": "<ISO time>",
        "keys": [ { "kid": "…", "x": "<Ed25519 public key, base64url>", "nbf": 1767225600, "exp": null } ] }
        // nbf / exp: Unix seconds; null or absent = no limit
    ]
  }
}
```

In `report` mode the worker ignores `content` and `access`, whatever the policy carries: nothing is served or
blocked.

#### 3.2.4 The check

The policy is **rejected as a whole** (treated like no policy, 3.2.1) when any of these fails. Keys the worker
doesn't know are ignored.

| Part | Rule |
|---|---|
| `schemaVersion` | exactly `2` |
| `version` | a string |
| `ttlSeconds` | a number (then clamped to 5–300) |
| `mode` | `report` or `autopilot` |
| `agents[]` | `key` a non-empty string; `kind` `ai`, `search` or `tool`; `ua` and `uaExact` lists of non-empty **lowercase** strings; `page` `agent` or `human`; `ipSets`, if present, a list of non-empty strings; `signer`, if present, a non-empty string (compared lowercased) |
| `patterns.botLike`, `patterns.crawler` | valid regular expressions (used case-insensitively) |
| `content`, `access`, `verification` | present, and `null` or an object |
| `content.serveBaseUrl` | an absolute URL |
| `content.negotiate` | `true` or `false` |
| `content.excludePaths[]` | paths: `/` followed by no `?`, `#` or whitespace |
| `content.files[]` | `path` a path; `action` `proxy` or `fallback`; `contentType` a non-empty string; `version` a string |
| `content.proxies[]` | `path` `/` followed by at least one character with no `?`, `#` or whitespace; `methods` an object of absolute URLs |
| `access` | `impersonators` `flag` or `block`; `blocked` a list of non-empty strings; `routes[]` with a string `id`, `kind` `exact` or `prefix`, a path, and `action` `block` or `passthrough` |
| `verification` | `maxAgeSeconds` a positive number; `ipSets` an object of `{cidrs: [strings], fetchedAt: string}`; `signers[]` with a non-empty `host`, a string `fetchedAt` and `keys[]` of string `kid` and `x` and optional numeric `nbf`/`exp` |

Two values are never a reason to reject: an IP range that isn't a CIDR is ignored, and a `fetchedAt` that isn't a
readable date makes that data never fresh (4.7). Both come from bot vendors' published files.

### 3.3 Serving content

Used for files, explicit markdown URLs and the agent version of a page (section 6).

**Request:** `GET` to `content.serveBaseUrl` + the path (leading slash removed, repeated slashes collapsed). Redirects
are not followed. `serveBaseUrl` is used as the policy gives it: unlike proxy targets, it isn't restricted to Dedica's
origin or to `https`, and the token is sent to it.

| What is served | Path sent | Query string sent | `x-dedica-category` | `x-dedica-version` | Shared |
|---|---|---|---|---|---|
| File | the file's path | none | `public` | `v2:` + the file's `version`, else the policy's | yes |
| Explicit markdown URL (`/pricing.md`) | the requested path, suffix included | the visitor's | `public` | `v2:` + the policy's `version` | yes |
| Agent version of a page (`/pricing`) | the requested path | the visitor's | `eligible` | `v2:` + the policy's `version` | no |

Other headers sent, besides the common ones: `user-agent` and `accept` (the visitor's, empty if none), and
`if-none-match` / `if-modified-since` (the visitor's, only when shared and at most 8192 characters). No cookies,
credentials or other visitor headers are sent.

**Unsafe paths are never sent.** If the path, after percent-decoding each segment, contains a `.` or `..` segment or
an encoded `/` or `\`, or would resolve outside `serveBaseUrl`, Dedica isn't asked and the origin answers.

**How Dedica's answer is used:**

| Dedica answers | Result |
|---|---|
| 200 | Served to the visitor. |
| 304 | Served (no body) when shared; otherwise the origin answers. |
| 401, 403 or 5xx | The origin answers, and serving backs off. |
| Any other status (404: Dedica has nothing here) | The origin answers. No back-off. |
| Network error, time limit reached, body over 8 MiB or too slow | The origin answers, and serving backs off. |

**Back-off:** for 15 s no serve requests are made (the origin answers instead), and every serve request still waiting
on Dedica in that instance is abandoned at once, each falling back to the origin. Back-off is cleared when the policy's
`serveBaseUrl` changes. Back-off does not apply to proxied paths.

**Time limits:** 10 s (1.5 s for the agent version of a page), applied both to Dedica starting to answer and to
reading the body.

**Response sent to the visitor:**

| Header | Value |
|---|---|
| `content-type` | Dedica's; if absent, the file's `contentType`, or `text/plain; charset=utf-8` for markdown |
| `x-dedica-served` | `1` |
| `cache-control` | shared and status 200/304: Dedica's `cache-control`, or `no-store` if it sent none. Otherwise `private, no-store`. |
| `vary` | `accept, accept-encoding, user-agent, sec-fetch-mode, sec-fetch-dest` |
| `etag`, `last-modified`, `age`, `date`, `expires` | Dedica's, only when shared and status 200/304 |

No other header from Dedica is passed on. A `HEAD` request gets the same status and headers with no body.

### 3.4 Proxied paths (`content.proxies`, e.g. `/ask`, `/mcp`)

A request is proxied when its path equals a `proxies` entry's `path` (trailing slashes ignored on both sides,
case-sensitive) and the entry has a target for the request's method in `methods`. If several entries have the same
path, only the first counts.

**Not proxied (handling continues at section 6, step c):**

- the target URL's origin isn't `DEDICA_QUERY_ORIGIN` (or, when unset, `DEDICA_API_URL`'s origin);
- the target, or the allowed origin, isn't `https` (plain `http` is allowed only for `localhost`, `*.localhost` and
  `127.0.0.1`);
- the target contains a username, password or fragment;
- the visitor's query string is over 32,768 characters.

These conditions are checked only after the block and `passthrough` checks of section 6, step b, which need nothing
more than a listed path and method.

**The origin answers** (with the complete original request, body included) when the request was sent but Dedica can't
be reached, the visitor's body is over 32,768 bytes, or the forwarded visitor headers (names plus values) total over
16,384 characters.

**Request to Dedica:** same method, to the target URL with its query string replaced by the visitor's, with the
visitor's body. Redirects are not followed. Headers: the common ones plus only these from the visitor, if present:
`accept`, `content-type`, `origin`, `user-agent`, `sec-fetch-mode`, `sec-fetch-dest`, `mcp-protocol-version`,
`mcp-session-id`, `mcp-method`, `mcp-name`, `last-event-id`, and any `mcp-param-*`.

**Response to the visitor:** Dedica's status, whatever it is (errors included), with its body streamed as it arrives
(server-sent events work). Headers:

| Header | Value |
|---|---|
| `cache-control` | `private, no-store` |
| `x-dedica-served` | `1` |
| `x-accel-buffering` | `no` |
| `content-type`, `retry-after`, `allow`, `mcp-protocol-version`, `mcp-session-id`, `vary` | Dedica's, when present |

No other header from Dedica is passed on, `Location` included: a redirect from Dedica reaches the visitor without
it.

The whole exchange, streaming included, is cut off after 50 s.

### 3.5 Heartbeat

Every 5 minutes: `POST /api/v1/middleware/heartbeat/`, `content-type: application/json`, body
`{"middleware":"cloudflare-worker","version":"2.0.0"}`, time limit 5 s. A failure is only logged. Skipped when the
worker is disabled or not configured. Policy requests also tell Dedica the worker is live.

### 3.6 Traffic events

`POST /api/v1/middleware/events/`, `content-type: application/x-ndjson`, header `x-dedica-batch-id: <random UUID>`,
body: one JSON event per line (section 8), time limit 5 s. Dedica answers `202` once the batch is queued (it checks
each event later, so one bad line never fails the rest); the worker doesn't read the body.

---

## 4. Recognising clients

Everything here comes from the policy's `agents` and `patterns`. It is worked out once per request
(`request/classify.ts`).

### 4.1 Classification

**Tools** (`kind: "tool"`) are never used for classification: they only name a client (4.7) and let a site block it
(5.2). A request is classified by the first rule that applies:

1. The UA equals an entry's `uaExact` value → that entry (a `search` entry before an `ai` one).
2. The longest `ua` needle the UA contains decides → that entry. On equal length a `search` entry wins, then the
   earlier entry. So `applebot-extended` can be an AI agent while `applebot` is a search engine.
3. The lowercased `Signature-Agent` header contains an agent's `signer` host → **signed agent** (matched: the host).
   The signature itself is not checked here.
4. The UA is non-empty, the request has no `Sec-Fetch-Mode` header, and the UA matches `patterns.botLike` →
   **automated client**.
5. Otherwise → **unknown** (most likely a person).

Rules 1–2 apply only to a non-empty UA. An entry of kind `search` makes the client a **search engine** (search
engines, link previews, monitors); one of kind `ai` an **AI agent**. The recognised signing host (rule 3's test) is
recorded whatever rule decided.

A **browser navigation** is a request with `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`.

### 4.2 Wants the agent version

A client wants the agent version when it is:

- an **AI agent**, unless it is a browser navigation with no recognised signing host; or
- a **signed agent**; or
- an **automated client**.

Search engines and unknown clients never do.

### 4.3 Keeps the person's page

A client keeps the person's page (at any URL, `.md` included) when its entry (4.1, rules 1–2) has `page: "human"`,
or, when it matched no entry, its UA is non-empty and matches `patterns.crawler`.

### 4.4 Eligible paths

A path is eligible for an agent version unless it falls under a `content.excludePaths` entry: equals it, or starts
with it followed by `/` (an entry ending in `/` matches anything starting with it).

### 4.5 A page read

A request at a normal page URL may get the agent version only if it looks like a page read. It does not if any of
these hold:

- the path ends in `.js`, `.mjs`, `.css`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.ico`, `.woff`, `.woff2`, `.ttf`,
  `.otf`, `.eot`, `.map`, `.webp`, `.avif`, `.mp4`, `.webm`, `.mp3`, `.wav` or `.pdf` (any case);
- it has an `Authorization`, `Cookie`, `Upgrade`, `Range` or `X-Requested-With` header;
- it has a `Sec-Fetch-Dest` other than `document`, `iframe` or `frame`;
- its `Accept` mentions `json` and mentions neither `text/html` nor `text/markdown`.

### 4.6 A markdown URL

A path ending in `.md`. The page it is the version of is the path without the suffix (`/pricing.md` → `/pricing`,
`/.md` → `/`).

### 4.7 Identity verdicts (Agent Access)

Worked out only when the policy has `verification`, in every mode. The client IP (`CF-Connecting-IP`) is used for
this check and, hashed, for the visitor pseudonym (8.2). The IP itself is never sent anywhere.

The UA **names an agent** when it matches an entry by rules 1–2 of 4.1; if none matches, the same rules over the
`tool` entries. That gives the agent's key.

| Verdict | When | Agent reported |
|---|---|---|
| `verified` (signed) | A valid Web Bot Auth signature (below) | the named agent if it signs with that host, else the first agent (in `agents` order) whose `signer` is that host |
| `verified` | The UA names an agent, and the client IP is in one of its fresh IP sets | the named agent |
| `impersonator` | The UA names an agent that has at least one fresh IP set, and the client IP is in none of them | the named agent |
| `claimed` | The UA names an agent, but it has no fresh IP set, or there is no valid client IP | the named agent |
| `unknown` | Names no agent, but classification (4.1) isn't **unknown** | none |
| no verdict | Names no agent and classification is **unknown** (a person) | — |

An agent's IP sets are its `ipSets` that `verification.ipSets` has. Data is **fresh** when its `fetchedAt` is no more
than `maxAgeSeconds` old. IPv4, IPv6 and IPv4-mapped IPv6 addresses are supported. An error while checking signatures
counts as "no valid signature", and the UA and IP checks still run. Any other error while working out a verdict means
no verdict.

**A valid Web Bot Auth signature** (RFC 9421, Ed25519) needs `Signature-Agent`, `Signature-Input` and `Signature`
headers, and at least one signature in them that:

- has `tag="web-bot-auth"`, and `alg` absent or `ed25519`;
- has both `created` and `expires`; `expires` is in the future and `created` no more than 60 s in the future;
- covers `@authority` and `signature-agent`, and uses no component parameter other than `key`;
- names a signing host that is a fresh `verification.signers` entry. The host is read from `Signature-Agent`: a single
  value is used as is. For a dictionary, if the signature covers `signature-agent` with a `key`, the member with that
  key is used (none if it is missing). Otherwise the member with the signature's label is used, else the only member;
- uses a `keyid` matching one of that entry's keys, currently within the key's `nbf`/`exp`;
- has its value in the `Signature` header under the same label, as `:<base64>:`;
- verifies against that key.

---

## 5. Agent Access rules

### 5.1 When they apply

Only when the policy has `access` (Dedica sends it only while the site's rules are enforced) and is in `autopilot`.
Otherwise nothing is blocked and route rules are ignored (verdicts are still reported).

### 5.2 Block rules

Checked in this order; the first that applies blocks the request:

| # | Blocks | `block_rule` |
|---|---|---|
| 1 | `impersonators` is `block`, and the verdict is `impersonator` | `impersonator` |
| 2 | The UA equals a `uaExact` value or contains a `ua` needle of a blocked `search` entry (search engines, previews, monitors blocked by name) | `serve_human` |
| 3 | The client is not a search engine, the request is not a browser navigation, and the UA equals a `uaExact` value or contains a `ua` needle of a blocked `ai` or `tool` entry | `crawler` |
| 4 | `blocked` is non-empty, the request has a `Signature-Agent` header, its verdict is signed-verified, and the verified agent is blocked | `crawler` |
| 5 | The route rule for the path (5.3) is `block`, the client is not a search engine, and it wants the agent version (4.2) | `route` |

An entry is **blocked** when its `key` is in `access.blocked`. Rules 1–2 and 4 apply whatever the request looks
like. No header or user agent exempts a request.

### 5.3 Route rules

Paths are compared after collapsing repeated slashes and dropping a trailing slash, on both sides; comparison is
case-sensitive.

- `exact` matches that path only. `prefix` matches the path and everything under it (`/docs` matches `/docs` and
  `/docs/a`, not `/docsx`); a `prefix` of `/` matches everything.
- An `exact` match beats any `prefix`; a longer `prefix` beats a shorter one; on a tie, the first rule wins.
- The request's own path is looked up first. If no rule matches it and it is a markdown URL (4.6), the page it is the
  version of is looked up.

`block`: see 5.2 rule 5. `passthrough`: the origin answers the path, with no agent version, no markdown version and
no proxying. Rules 1–4 of 5.2 still apply on a `passthrough` path, and files (section 6, step e) are still answered.

---

## 6. How each request is handled

Steps run in order; the first that answers ends handling. Steps 1–4 are in `worker.ts`, step 5 and a–k in
`decide/decide.ts` (which decides without calling anyone), and `execute.ts` carries the decision out. "Reported as X"
means a traffic event with outcome `X` is recorded if the request is reportable (section 8.1).

**1. Status check.** `GET /__dedica/status` → `200` JSON, `cache-control: no-store`, always (even disabled or not
configured), no call to Dedica, not reported:

```json
{ "configured": true, "disabled": false, "siteId": "<site id or null>", "mode": "autopilot", "version": "2.0.0" }
```

`mode` is the mode of the policy this instance currently holds, or `null`. `siteId` is `null` when unset or empty.

**2. Kill switch.** Disabled → the origin answers. No call to Dedica, not reported.

**3. Installation proof.** `GET /.well-known/dedica.json` → `200` JSON, `cache-control: no-store`, even when not
configured, no call to Dedica, not reported:

```json
{ "site_id": "<DEDICA_SITE_ID, or null when unset>", "middleware": "cloudflare-worker", "version": "2.0.0" }
```

**4. Not configured** → the origin answers. Not reported.

Every other request first obtains the policy, waiting if needed (3.2.2), people included. The one exception is step
5 with a method other than `GET` or `HEAD`, which needs none.

**5. Dedica's own crawler.** A request with `X-Dedica-Origin-Fetch: 1`:

- `GET` or `HEAD`, with a policy: if a block rule (5.2) applies → `403` (section 7), reported as `blocked`. Otherwise
  the origin answers, not reported.
- Anything else: the origin answers, not reported.

This header never gets Dedica's content: files, markdown versions and proxied paths are all answered by the origin.
The block check runs before anything else here, so a blocked bot sending this header is blocked even on a file path
such as `/robots.txt`.

**Every other request:**

  a. **No policy, or no `content`** (report mode) → the origin answers, reported as `origin`.

  b. **Proxied path** (3.4). The path and method only have to be listed in `proxies`: the checks below run even if
     the request couldn't actually be proxied.
     - a block rule (5.2) applies → `403` JSON (section 7), reported as `blocked`. Nothing is sent to Dedica.
     - the route rule for the path is `passthrough` → the origin answers, reported as `origin`.
     - the request may be sent (3.4) → proxied, reported as `proxied`; if Dedica can't be reached, the origin answers,
       reported as `origin`.
     - otherwise handling continues at step c.

  c. **Not a `GET` or `HEAD`** → the origin answers, reported as `origin`.

  e. **File.** The path equals a `content.files` entry's `path` exactly (first match wins). Applies to every visitor,
     people included, and before any block rule, so a blocked crawler can still read `/robots.txt`.

     | `action` | Behaviour | Reported as |
     |---|---|---|
     | `proxy` | Dedica's file (3.3). If Dedica has none, the origin answers. | `artifact`, or `origin` |
     | `fallback` | The origin is asked first. If it has its own file (any 3xx, or a 2xx whose `content-type` isn't HTML), that is the answer. Otherwise Dedica's file if it has one, else the origin's response. | `artifact_origin` (origin's) or `artifact` (Dedica's) |

  f. **Block rules** (5.2) → `403` (section 7), reported as `blocked`.

  g. **`passthrough` route** (5.3) → the origin answers, reported as `origin`.

  h. **Keeps the person's page** (4.3) → the origin answers, reported as `human_page`.

  i. **Markdown URL** (4.6):
     - the page it is the version of isn't eligible (4.4) → the origin answers, reported as `origin`;
     - otherwise Dedica's markdown (3.3, shared), reported as `twin`. If Dedica has none, the origin answers, reported
       as `origin`.

     This is served to anyone who asks for the URL, people and requests with cookies included, unless step h kept
     the person's page.

  j. **Agent version of a page.** All of these must hold:
     - `content.negotiate` is `true`;
     - the request is a page read (4.5);
     - the client is not a search engine (4.1);
     - the `Accept` header contains `text/markdown`, or the client wants the agent version (4.2);
     - the path is eligible (4.4).

     Then Dedica's agent version (3.3, private, 1.5 s limit), reported as `negotiated`. If Dedica has none, is too
     slow, or answers 304, the origin answers, reported as `origin`.

  k. Otherwise the origin answers, reported as `origin`.

If anything fails unexpectedly while deciding, the origin answers (reported as `origin`, or not at all for step 5).

### 6.1 By mode

| | `report` | `autopilot` |
|---|---|---|
| Policy fetched, heartbeat, traffic events | yes | yes |
| Identity verdicts in events | yes | yes |
| Proxied paths, files, markdown, agent versions | no, the origin answers everything | yes |
| Agent Access blocking and route rules | no | only while the policy has `access` |

---

## 7. Responses the worker creates itself

| Case | Status | Body | Headers |
|---|---|---|---|
| Blocked (5.2) on a page, a file or by step 5 | 403 | `Not available to this client.` | `content-type: text/plain; charset=utf-8` |
| Blocked (5.2) on a proxied path | 403 | `{"error":"QUERY_FORBIDDEN","message":"Not available to this client."}` | `content-type: application/json`, `cache-control: no-store` |
| Status check | 200 | JSON (step 1) | `cache-control: no-store` |
| Installation proof | 200 | JSON (step 3) | `cache-control: no-store` |

Every other response is either the origin's, unchanged, or Dedica's (3.3, 3.4). (`src/responses.ts`)

---

## 8. Traffic reporting

### 8.1 What is reported

Reported: requests handled in steps a–k, and requests blocked in step 5, that are **reportable**. Not reported: status
checks, installation proofs, requests while disabled or not configured, and Dedica's crawler when not blocked.

A request is **not** reportable when:

- its last path segment ends in `.js`, `.mjs`, `.css`, `.map`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`,
  `.avif`, `.ico`, `.woff`, `.woff2`, `.ttf`, `.otf`, `.eot`, `.mp4`, `.webm`, `.mp3` or `.wav` (any case);
- it has a `Sec-Fetch-Dest` other than `document`, `iframe` or `frame`;
- its `Sec-Purpose` or `Purpose` header contains `prefetch`.

All methods are reported (e.g. `POST /mcp`).

### 8.2 Event

| Field | Content |
|---|---|
| `id` | random UUID |
| `ts` | ISO time the event was recorded |
| `method` | request method |
| `host` | request host (with port, if any) |
| `path` | request path, at most 2048 characters |
| `query` | only `utm_source`, `utm_medium`, `utm_campaign`, `ref`, `source` (non-empty, each cut to 128 characters), as `?…`; at most 2048 characters, shortening the longest value first. Absent when none. |
| `status` | status of the response sent |
| `latency_ms` | milliseconds from receiving the request to recording the event |
| `outcome` | section 10 |
| `served_by_dedica` | `true` when the response carries `x-dedica-served: 1`, or the outcome is `proxied` or `blocked` |
| `category` | `public` (`artifact`, `artifact_origin`, `twin`), `eligible` (`negotiated`), otherwise `null` |
| `client` | `null` when the instance holds no policy (see below). Otherwise `kind`: `ai_agent` (AI agent or signed agent, 4.1), `bot` (search engine or automated client), `unknown`; `matched`: what decided it, or `null`; `signature_agent`: the recognised signing host, or `null`; `verification` and `agent`: the verdict and its agent key (4.7), only when there is a verdict. |
| `block_rule` | the 5.2 rule that blocked it; only for Agent Access blocks |
| `user_agent` | the `User-Agent` header as sent, at most 512 characters |
| `referer` | the `Referer`'s origin and path only, at most 2048 characters; absent when missing or invalid |
| `visitor` | daily pseudonym: SHA-256 (hex) of `<client IP>|<User-Agent>|<UTC date YYYY-MM-DD>|<DEDICA_SALT>`. Absent without `DEDICA_SALT` or without a client IP. |
| `country` | `CF-IPCountry` header, else Cloudflare's country, else `null` |
| `headers` | `accept`, `accept-language`, `sec-fetch-mode`, `sec-fetch-dest`, `sec-fetch-site`, when present, each at most 256 characters |
| `mode` | the policy's mode, or `null` |
| `policy_version` | the policy's `version`, or `null` |

`client`, `mode` and `policy_version` use the last policy the instance received, at the time the event is
recorded. This includes a policy too old to be used for handling requests (3.2.2). They are `null` only when the
instance has never received a usable policy, or has dropped it (3.2.1).

Events never contain the client IP, cookies, the full query string, other request headers, or the token.

### 8.3 Delivery

- Events are collected per instance and sent in batches of at most 1000: immediately once 1000 are waiting, otherwise
  5 s after the first event of a batch.
- `429`, `503`, a network error or the time limit → the batch is kept and retried at the next send (which happens
  once more traffic arrives). After such a failure at most 5000 unsent events are kept per instance; the newest
  beyond that are dropped.
- There is no back-off for events. While 1000 or more are waiting (for example after failed sends), every new
  reportable request immediately triggers a send of up to 1000 events, and several sends can run at once.
- Any other non-`202` status → the batch is dropped (logged).

---

## 9. Time limits and back-off

| Call | Limit | On failure |
|---|---|---|
| Policy | 4 s | Retry after 15 s (5 min for 401/403, 60 s for a policy that fails its check) |
| Serve (files, markdown URLs) | 10 s, applied to starting the answer and to reading the body | Origin answers; serving off for 15 s |
| Serve (agent version of a page) | 1.5 s, applied to starting the answer and to reading the body | Origin answers; serving off for 15 s |
| Proxied path | 50 s for the whole exchange | Origin answers if Dedica hadn't answered yet |
| Heartbeat | 5 s | Logged |
| Traffic events | 5 s | Batch kept for the next send |

Limits on content: a served body over 8 MiB is refused (origin answers). A proxied request with a query string over
32,768 characters is not proxied (3.4); one with a body over 32,768 bytes, or forwarded headers over 16,384
characters, is answered by the origin.

---

## 10. Outcomes

| Outcome | Meaning |
|---|---|
| `proxied` | A proxied path, answered by Dedica |
| `artifact` | A file Dedica manages, served from Dedica |
| `artifact_origin` | A `fallback` file answered by the origin |
| `blocked` | An Agent Access 403 |
| `twin` | An explicit markdown URL, served from Dedica |
| `negotiated` | The agent version of a normal page URL, served from Dedica |
| `human_page` | The client keeps the person's page (4.3); the origin answered |
| `origin` | The origin answered |
