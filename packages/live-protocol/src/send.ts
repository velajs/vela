/** Admission to the local transport, never an acknowledgment from the remote peer. */
export type WebSocketSendResult = 'accepted' | 'closed' | 'too-large' | 'backpressure';

export interface WebSocketSendPolicy {
  /** Native queued bytes plus the next frame, when the runtime exposes bufferedAmount. Default 1 MiB. */
  maxBufferedBytes?: number;
  /** Bytes admitted in a fixed one-second window; no timers/queues are created. Default 1 MiB. */
  maxBytesPerSecond?: number;
}

export interface WebSocketSender {
  readonly readyState?: number;
  readonly bufferedAmount?: number;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
}

const DEFAULT_LIMIT = 1024 * 1024;
const encoder = new TextEncoder();
const limit = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError('Invalid WebSocket send limit');
  return value;
};

/** Connection-owned admission state. Recreate after hibernation; never persist an outgoing queue. */
export class WebSocketSendGate {
  readonly #maxBufferedBytes: number;
  readonly #maxBytesPerSecond: number;
  #window: number | undefined;
  #bytes = 0;
  #closed = false;

  constructor(policy: WebSocketSendPolicy = {}) {
    this.#maxBufferedBytes = limit(policy.maxBufferedBytes);
    this.#maxBytesPerSecond = limit(policy.maxBytesPerSecond);
  }

  trySend(sender: WebSocketSender, payload: string, maxFrameBytes: number): WebSocketSendResult {
    if (this.#closed || (sender.readyState !== undefined && sender.readyState !== 1))
      return 'closed';
    const bytes = encoder.encode(payload).byteLength;
    if (bytes > maxFrameBytes) return this.#reject(sender, 'too-large', 1009, 'Message too large');
    const now = Date.now();
    if (this.#window === undefined || now - this.#window >= 1000 || now < this.#window) {
      this.#window = now;
      this.#bytes = 0;
    }
    const buffered = sender.bufferedAmount;
    if (
      this.#bytes + bytes > this.#maxBytesPerSecond ||
      (buffered !== undefined &&
        (!Number.isFinite(buffered) || buffered < 0 || buffered + bytes > this.#maxBufferedBytes))
    )
      return this.#reject(sender, 'backpressure', 1013, 'WebSocket send budget exceeded');
    try {
      sender.send(payload);
      this.#bytes += bytes;
      return 'accepted';
    } catch {
      return this.#reject(sender, 'closed', 1011, 'WebSocket send failed');
    }
  }

  #reject(
    sender: WebSocketSender,
    result: WebSocketSendResult,
    code: number,
    reason: string,
  ): WebSocketSendResult {
    this.#closed = true;
    try {
      sender.close(code, reason);
    } catch {
      /* Already closed. */
    }
    return result;
  }
}
