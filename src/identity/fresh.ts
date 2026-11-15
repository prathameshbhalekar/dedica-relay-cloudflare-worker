/** Whether data Dedica fetched at `fetchedAt` is recent enough to prove anything. An unreadable date never is. */
export function fresh(fetchedAt: string, maxAgeSeconds: number, now: number): boolean {
  const at = Date.parse(fetchedAt);
  return Number.isFinite(at) && now - at <= maxAgeSeconds * 1000;
}
