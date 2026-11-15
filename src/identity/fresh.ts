import type { Verification } from "../policy/types";

/** Whether data Dedica fetched at `fetchedAt` is recent enough to prove anything. */
export function fresh(fetchedAt: string, v: Verification, now: number): boolean {
  const at = Date.parse(fetchedAt);
  return Number.isFinite(at) && now - at <= v.maxAgeSeconds * 1000;
}
