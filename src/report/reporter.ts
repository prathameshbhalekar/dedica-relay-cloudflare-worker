/**
 * The isolate's batch of unsent traffic events. Sent as NDJSON at MAX_BATCH events, or MAX_AGE_MS after the first
 * one; a batch Dedica can't take right now (429/503, network error) is kept and retried with the next one, up to
 * MAX_BUFFERED events. Never in the visitor's way: everything runs in `waitUntil`.
 */

import type { Ctx, Env } from "../config";
import type { DedicaClient } from "../dedica/client";
import type { TrafficEvent } from "./event";

export const MAX_BATCH = 1000;
export const MAX_AGE_MS = 5000;
/** How many unsent events an isolate keeps while Dedica is unavailable. */
export const MAX_BUFFERED = MAX_BATCH * 5;

export class Reporter {
  private buffer: TrafficEvent[] = [];
  private flushPending = false;

  constructor(
    private readonly client: DedicaClient,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  get pending(): number {
    return this.buffer.length;
  }

  /** Adds an event and makes sure it gets sent: now if the batch is full, else within MAX_AGE_MS. */
  async add(event: TrafficEvent, env: Env, ctx: Ctx): Promise<void> {
    this.buffer.push(event);
    if (this.buffer.length >= MAX_BATCH) await this.flush(env);
    else this.schedule(env, ctx);
  }

  private schedule(env: Env, ctx: Ctx): void {
    if (this.flushPending) return;
    this.flushPending = true;
    ctx.waitUntil(
      (async () => {
        await this.sleep(MAX_AGE_MS);
        this.flushPending = false;
        await this.flush(env);
      })(),
    );
  }

  /** Sends one batch. Never throws; a batch Dedica can't take right now is kept for the next one. */
  async flush(env: Env): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.slice(0, MAX_BATCH);
    this.buffer = this.buffer.slice(MAX_BATCH);
    try {
      const response = await this.client.events(env, batch.map((event) => JSON.stringify(event)).join("\n"));
      if (response.status !== 202) {
        console.warn(`[dedica] event batch ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
      } else {
        const body = (await response.json().catch(() => null)) as { accepted?: number; rejected?: number; errors?: unknown } | null;
        if (body?.rejected) console.warn(`[dedica] events: ${body.accepted} accepted, ${body.rejected} rejected`, body.errors);
      }
      if (response.status === 429 || response.status === 503) this.requeue(batch);
    } catch (err) {
      console.warn(`[dedica] event batch request failed: ${err}`);
      this.requeue(batch);
    }
  }

  private requeue(batch: TrafficEvent[]): void {
    this.buffer = batch.concat(this.buffer).slice(0, MAX_BUFFERED);
  }
}
