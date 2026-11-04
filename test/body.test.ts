import { describe, expect, it } from "vitest";

import { readCapped } from "../src/body";

function stream(chunks: string[], { stall = false } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!stall) controller.close();
    },
  });
}

describe("readCapped", () => {
  it("joins the chunks", async () => {
    const bytes = await readCapped(stream(["ab", "cd", "e"]), 10, new AbortController().signal);
    expect(new TextDecoder().decode(bytes)).toBe("abcde");
  });

  it("refuses a body that grows past the cap without announcing its length", async () => {
    await expect(readCapped(stream(["abc", "def"]), 5, new AbortController().signal)).rejects.toThrow(RangeError);
  });

  it("gives up on a body that stalls once the signal aborts", async () => {
    await expect(readCapped(stream(["abc"], { stall: true }), 10, AbortSignal.timeout(20))).rejects.toThrow("aborted");
  });

  it("refuses to start when the signal has already aborted", async () => {
    await expect(readCapped(stream(["abc"]), 10, AbortSignal.abort())).rejects.toThrow("aborted");
  });
});
