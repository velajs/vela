/** Bounded connection-local message work; no timers or persistent outgoing queue. */
export class WsMessageQueue {
  #tail: Promise<void> = Promise.resolve();
  #count = 0;
  #bytes = 0;
  #stopped = false;
  readonly #maxMessages: number;
  readonly #maxBytes: number;
  readonly #overflow: () => void;

  constructor(overflow: () => void, maxMessages = 64, maxBytes = 1024 * 1024) {
    if (
      !Number.isSafeInteger(maxMessages) ||
      maxMessages <= 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0
    ) {
      throw new RangeError('Invalid WebSocket pending-message limit');
    }
    this.#overflow = overflow;
    this.#maxMessages = maxMessages;
    this.#maxBytes = maxBytes;
  }

  stop(): void {
    this.#stopped = true;
  }

  run(frame: string | ArrayBuffer, work: () => Promise<void>): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    const bytes =
      typeof frame === 'string' ? new TextEncoder().encode(frame).byteLength : frame.byteLength;
    if (this.#count >= this.#maxMessages || this.#bytes + bytes > this.#maxBytes) {
      this.#stopped = true;
      this.#overflow();
      return Promise.resolve();
    }
    this.#count++;
    this.#bytes += bytes;
    const result = this.#tail
      .then(async () => {
        if (!this.#stopped) await work();
        return undefined;
      })
      .finally(() => {
        this.#count--;
        this.#bytes -= bytes;
      });
    // Observe failures immediately; a failed handler must not poison later work.
    this.#tail = result.catch(() => {});
    return result;
  }
}
