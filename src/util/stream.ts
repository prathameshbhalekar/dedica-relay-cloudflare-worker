/** Reads a body into memory. Throws once it passes `maxBytes` or `signal` aborts, cancelling the rest. */
export async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = stream.getReader();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("body read aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) await aborted;
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) await aborted;
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new RangeError("body exceeds limit");
      chunks.push(value);
    }
    return new Uint8Array(await new Blob(chunks).arrayBuffer());
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A read still pending after a cancel; the stream is done with either way.
    }
  }
}
