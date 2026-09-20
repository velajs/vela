// Ported near-verbatim from @stratal/testing (MIT, © Temitayo Fadojutimi).
// Web-standard only (ReadableStream + TextDecoder), so it is edge-pure.
import { expect } from 'vitest';

/** A parsed Server-Sent Event. */
export interface TestSseEvent {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

/**
 * TestSseConnection
 *
 * Reads a streaming `text/event-stream` response body and exposes queue-based
 * wait/assert helpers over the parsed events.
 *
 * @example
 * ```ts
 * const sse = await module.sse('/stream/events').connect();
 * await sse.assertEventData('ping');
 * await sse.waitForEnd();
 * ```
 */
export class TestSseConnection {
  private readonly eventQueue: TestSseEvent[] = [];
  private eventWaiters: ((event: TestSseEvent) => void)[] = [];
  private streamEnded = false;
  private endWaiters: (() => void)[] = [];

  constructor(private readonly response: Response) {
    this.startReading();
  }

  /** The raw `Response`. */
  get raw(): Response {
    return this.response;
  }

  /** Wait for the next event (rejects after `timeout` ms). */
  async waitForEvent(timeout = 5000): Promise<TestSseEvent> {
    if (this.eventQueue.length > 0) {
      return this.eventQueue.shift()!;
    }

    if (this.streamEnded) {
      throw new Error('SSE: stream has ended, no more events');
    }

    return new Promise<TestSseEvent>((resolve, reject) => {
      const waiter = (event: TestSseEvent): void => {
        clearTimeout(timer);
        resolve(event);
      };

      const timer = setTimeout(() => {
        const index = this.eventWaiters.indexOf(waiter);
        if (index !== -1) this.eventWaiters.splice(index, 1);
        reject(new Error(`SSE: no event received within ${timeout}ms`));
      }, timeout);

      this.eventWaiters.push(waiter);
    });
  }

  /** Wait for the stream to end (rejects after `timeout` ms). */
  async waitForEnd(timeout = 5000): Promise<void> {
    if (this.streamEnded) return;

    return new Promise<void>((resolve, reject) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        const index = this.endWaiters.indexOf(waiter);
        if (index !== -1) this.endWaiters.splice(index, 1);
        reject(new Error(`SSE: stream did not end within ${timeout}ms`));
      }, timeout);

      this.endWaiters.push(waiter);
    });
  }

  /** Collect all remaining events until the stream ends. */
  async collectEvents(timeout = 5000): Promise<TestSseEvent[]> {
    const events: TestSseEvent[] = [];

    if (this.streamEnded) {
      return [...this.eventQueue.splice(0)];
    }

    return new Promise<TestSseEvent[]>((resolve, reject) => {
      const originalDispatch = this.dispatchEvent.bind(this);
      this.dispatchEvent = (event: TestSseEvent): void => {
        events.push(event);
        originalDispatch(event);
      };

      const endWaiter = (): void => {
        clearTimeout(timer);
        this.dispatchEvent = originalDispatch;
        resolve(events);
      };

      const timer = setTimeout(() => {
        this.dispatchEvent = originalDispatch;
        const index = this.endWaiters.indexOf(endWaiter);
        if (index !== -1) this.endWaiters.splice(index, 1);
        reject(new Error(`SSE: stream did not end within ${timeout}ms`));
      }, timeout);

      events.push(...this.eventQueue.splice(0));

      this.endWaiters.push(endWaiter);
    });
  }

  /** Assert the next event matches the expected partial shape. */
  async assertEvent(expected: Partial<TestSseEvent>, timeout = 5000): Promise<void> {
    const event = await this.waitForEvent(timeout);
    expect(event).toMatchObject(expected);
  }

  /** Assert the next event's `data` equals `expected`. */
  async assertEventData(expected: string, timeout = 5000): Promise<void> {
    const event = await this.waitForEvent(timeout);
    expect(event.data, `Expected SSE data "${expected}", got "${event.data}"`).toBe(expected);
  }

  /** Assert the next event's `data` is JSON equal to `expected`. */
  async assertJsonEventData<T>(expected: T, timeout = 5000): Promise<void> {
    const event = await this.waitForEvent(timeout);
    const parsed = JSON.parse(event.data) as unknown;
    expect(parsed).toEqual(expected);
  }

  private startReading(): void {
    const body = this.response.body;
    if (!body) {
      this.streamEnded = true;
      return;
    }

    const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    let buffer = '';

    const read = async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = await reader.read();

          if (done) {
            if (buffer.trim()) {
              const event = this.parseEvent(buffer);
              if (event) this.dispatchEvent(event);
            }
            this.endStream();
            return;
          }

          buffer += decoder.decode(value, { stream: true });

          const parts = buffer.split('\n\n');
          buffer = parts.pop()!;

          for (const part of parts) {
            if (!part.trim()) continue;
            const event = this.parseEvent(part);
            if (event) this.dispatchEvent(event);
          }
        }
      } catch {
        this.endStream();
      }
    };

    void read();
  }

  private endStream(): void {
    this.streamEnded = true;
    for (const waiter of this.endWaiters) {
      waiter();
    }
    this.endWaiters = [];
  }

  private parseEvent(raw: string): TestSseEvent | null {
    const lines = raw.split('\n');
    const dataLines: string[] = [];
    let event: string | undefined;
    let id: string | undefined;
    let retry: number | undefined;

    for (const line of lines) {
      if (line.startsWith(':')) continue; // comment line

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const field = line.slice(0, colonIndex);
      const value =
        line[colonIndex + 1] === ' ' ? line.slice(colonIndex + 2) : line.slice(colonIndex + 1);

      switch (field) {
        case 'data':
          dataLines.push(value);
          break;
        case 'event':
          event = value;
          break;
        case 'id':
          id = value;
          break;
        case 'retry': {
          const parsed = parseInt(value, 10);
          if (!Number.isNaN(parsed)) retry = parsed;
          break;
        }
      }
    }

    if (dataLines.length === 0) return null;

    const result: TestSseEvent = { data: dataLines.join('\n') };
    if (event !== undefined) result.event = event;
    if (id !== undefined) result.id = id;
    if (retry !== undefined) result.retry = retry;

    return result;
  }

  private dispatchEvent(event: TestSseEvent): void {
    if (this.eventWaiters.length > 0) {
      this.eventWaiters.shift()!(event);
    } else {
      this.eventQueue.push(event);
    }
  }
}
