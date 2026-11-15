/** What the worker needs to know about a request that doesn't depend on the policy, worked out once. */

import { ORIGIN_FETCH_HEADER, UA_MATCH_MAX } from "../protocol";
import { STATIC_FILE, UNREPORTED_EXTENSIONS, extension } from "../util/paths";

export interface RequestFacts {
  request: Request;
  url: URL;
  /** The user agent, cut to UA_MATCH_MAX characters and lowercased: the form every list is matched against. */
  ua: string;
  /** GET or HEAD: the only methods that get Dedica's content (proxied paths aside). */
  read: boolean;
  /** `Accept: text/markdown`. */
  acceptsMarkdown: boolean;
  /** A person opening a page in a browser. */
  browserNavigation: boolean;
  /** Sent by Dedica's own crawler (`X-Dedica-Origin-Fetch: 1`). Proves nothing: anyone can send it. */
  originFetch: boolean;
  /** Looks like a page read, so it may get the agent version at its normal URL (see `isPageRead`). */
  pageRead: boolean;
  /** A page load worth reporting (see `isReportable`). */
  reportable: boolean;
}

export function requestFacts(request: Request): RequestFacts {
  const url = new URL(request.url);
  const h = request.headers;
  return {
    request,
    url,
    ua: userAgent(h),
    read: request.method === "GET" || request.method === "HEAD",
    acceptsMarkdown: (h.get("accept") ?? "").includes("text/markdown"),
    browserNavigation: isBrowserNavigation(h),
    originFetch: h.get(ORIGIN_FETCH_HEADER) === "1",
    pageRead: isPageRead(h, url.pathname),
    reportable: isReportable(url, h),
  };
}

export function userAgent(headers: Headers): string {
  return (headers.get("user-agent") ?? "").slice(0, UA_MATCH_MAX).toLowerCase();
}

export function isBrowserNavigation(headers: Headers): boolean {
  return headers.get("sec-fetch-mode") === "navigate" && headers.get("sec-fetch-dest") === "document";
}

/** Headers that mark an API call, a session, a partial download or a protocol switch: never a page read. */
const NOT_A_PAGE_HEADERS = ["authorization", "cookie", "upgrade", "range", "x-requested-with"];
const PAGE_DESTS = new Set(["document", "iframe", "frame"]);

/**
 * Whether a request at a normal URL may get Dedica's agent version at all. Anything that looks like an API call or
 * a page's sub-request always gets the origin's answer, without asking Dedica: a static file, a request carrying
 * credentials, a cookie, a range or an upgrade, a browser's non-page fetch, or an `Accept` that asks for JSON
 * rather than a page.
 */
function isPageRead(h: Headers, pathname: string): boolean {
  if (STATIC_FILE.test(pathname)) return false;
  if (NOT_A_PAGE_HEADERS.some((name) => h.has(name))) return false;
  const dest = h.get("sec-fetch-dest");
  if (dest !== null && !PAGE_DESTS.has(dest)) return false;
  const accept = (h.get("accept") ?? "").toLowerCase();
  return !(accept.includes("json") && !accept.includes("text/html") && !accept.includes("text/markdown"));
}

/** Whether a request is a page load worth reporting: not a static file, a browser sub-request or a prefetch. */
function isReportable(url: URL, h: Headers): boolean {
  const ext = extension(url.pathname);
  if (ext !== null && UNREPORTED_EXTENSIONS.has(ext)) return false;
  const dest = h.get("sec-fetch-dest");
  if (dest !== null && !PAGE_DESTS.has(dest)) return false;
  return !`${h.get("sec-purpose") ?? ""} ${h.get("purpose") ?? ""}`.includes("prefetch");
}
