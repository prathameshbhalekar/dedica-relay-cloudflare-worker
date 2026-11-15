/**
 * Serving's circuit breaker. When a call to Dedica fails, serving is off for a while, and every call still waiting
 * on Dedica is released at once (each falls back to the origin), so a stalled Dedica holds no request longer.
 */
export class CircuitBreaker {
  private until = 0;
  private controller = new AbortController();
  private guarded = "";

  constructor(
    private readonly backoffMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Clears the back-off when what it protects changes (a new serve base URL). */
  guard(key: string): void {
    if (key === this.guarded) return;
    this.guarded = key;
    this.until = 0;
  }

  /** Serving is backed off. */
  get open(): boolean {
    return this.now() < this.until;
  }

  /** Aborts when the breaker trips: shared by every call in flight. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  trip(): void {
    this.until = this.now() + this.backoffMs;
    this.controller.abort(new Error("dedica serving backed off"));
    this.controller = new AbortController();
  }
}
