/** Path helpers shared by matching, proxying and reporting. */

/** Trailing slashes dropped (`/mcp/` is `/mcp`); `/` stays `/`. Used to match proxied paths. */
export function trimTrailingSlashes(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Repeated slashes collapsed and one trailing slash dropped. Used on both sides of a route-rule match. */
export function normalRoutePath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

/** Whether `pathname` is `prefix` or under it (`/docs` covers `/docs/a`, not `/docsx`; `/docs/` covers `/docs/a`). */
export function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/** The suffix of a page's markdown version (`/pricing.md`). */
export const MARKDOWN_SUFFIX = ".md";

/** The page a markdown URL is the version of (`/pricing.md` -> `/pricing`, `/.md` -> `/`), or null. */
export function markdownPage(pathname: string): string | null {
  return pathname.endsWith(MARKDOWN_SUFFIX) ? pathname.slice(0, -MARKDOWN_SUFFIX.length) || "/" : null;
}

/** Whether a page path may get an agent version: not under any excluded prefix. */
export function eligible(pathname: string, excludePaths: string[]): boolean {
  return !excludePaths.some((p) => underPrefix(pathname, p));
}

/** Static files that never get an agent version: scripts, styles, images, fonts, media and PDFs. */
export const STATIC_FILE = /\.(?:js|mjs|css|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|eot|map|webp|avif|mp4|webm|mp3|wav|pdf)$/i;

/** Static files that are not reported as page loads. Unlike STATIC_FILE, a PDF is reported. */
export const UNREPORTED_EXTENSIONS = new Set([
  "js", "mjs", "css", "map", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico",
  "woff", "woff2", "ttf", "otf", "eot", "mp4", "webm", "mp3", "wav",
]); // prettier-ignore

/** The extension of a path's last segment, lowercased, or null. */
export function extension(pathname: string): string | null {
  const dot = pathname.lastIndexOf(".");
  return dot > pathname.lastIndexOf("/") ? pathname.slice(dot + 1).toLowerCase() : null;
}
