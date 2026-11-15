/** User-agent matching: whole user agents first, then the longest needle the user agent contains. */

export interface Needles<T> {
  exact: Map<string, T>;
  /** Longest first, so the most specific wins (`applebot-extended` before `applebot`). */
  contains: [string, T][];
}

/** `entries` in order of precedence: on a tie (same length, or the same exact user agent) the earlier one wins. */
export function needles<T>(entries: { ua: string[]; uaExact: string[]; value: T }[]): Needles<T> {
  const exact = new Map<string, T>();
  const contains: [string, T][] = [];
  for (const { ua, uaExact, value } of entries) {
    for (const n of uaExact) if (!exact.has(n)) exact.set(n, value);
    for (const n of ua) contains.push([n, value]);
  }
  // Array.prototype.sort is stable: equal lengths keep the order of precedence.
  contains.sort((a, b) => b[0].length - a[0].length);
  return { exact, contains };
}

/** What a (lowercased) user agent matches, and the needle that decided it; null for no match or no user agent. */
export function match<T>(n: Needles<T>, ua: string): { value: T; needle: string } | null {
  if (!ua) return null;
  const exact = n.exact.get(ua);
  if (exact !== undefined) return { value: exact, needle: ua };
  const hit = n.contains.find(([needle]) => ua.includes(needle));
  return hit ? { value: hit[1], needle: hit[0] } : null;
}
