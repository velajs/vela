// Ported from @stratal/testing (MIT, © Temitayo Fadojutimi). Web-standard
// `WebSocket` wrapper; the optional `cleanup` hook lets a transport adapter
// (e.g. websocket-node) tear down its server when the socket closes.
import { expect } from 'vitest';

/**
 * TestWsConnection
 *
 * Wraps a live `WebSocket` with queue-based wait/assert helpers. Transport is
 * supplied by the caller — the core harness never opens a socket itself (see
 * `@velajs/testing/websocket-node`).
 *
 * @example
 * ```ts
 * const ws = await module.ws('/ws/chat').connect();
 * ws.send('hi');
 * await ws.assertMessage('echo:hi');
 * ws.close();
 * ```
 */
export class TestWsConnection {
  private readonly messageQueue: (string | ArrayBuffer)[] = [];
  private messageWaiters: ((data: string | ArrayBuffer) => void)[] = [];
  private closeEvent: { code?: number; reason?: string } | null = null;
  private closeWaiters: ((event: { code?: number; reason?: string }) => void)[] = [];

  constructor(
    private readonly ws: WebSocket,
    private readonly cleanup?: () => void | Promise<void>,
  ) {
    this.ws.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as string | ArrayBuffer;
      if (this.messageWaiters.length > 0) {
        this.messageWaiters.shift()!(data);
      } else {
        this.messageQueue.push(data);
      }
    });

    this.ws.addEventListener('close', (event: CloseEvent) => {
      this.closeEvent = { code: event.code, reason: event.reason };
      for (const waiter of this.closeWaiters) {
        waiter(this.closeEvent);
      }
      this.closeWaiters = [];
      void this.cleanup?.();
    });
  }

  /** The raw `WebSocket`. */
  get raw(): WebSocket {
    return this.ws;
  }

  /** Send a message. */
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    // The runtime WebSocket.send accepts all of these; the cast bridges the
    // slight type differences between DOM/undici and Bun's WebSocket typings.
    this.ws.send(data as Parameters<WebSocket['send']>[0]);
  }

  /** Close the connection. */
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  /** Wait for the next message (rejects after `timeout` ms). */
  async waitForMessage(timeout = 5000): Promise<string | ArrayBuffer> {
    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift()!;
    }

    return new Promise<string | ArrayBuffer>((resolve, reject) => {
      const waiter = (data: string | ArrayBuffer): void => {
        clearTimeout(timer);
        resolve(data);
      };

      const timer = setTimeout(() => {
        const index = this.messageWaiters.indexOf(waiter);
        if (index !== -1) this.messageWaiters.splice(index, 1);
        reject(new Error(`WebSocket: no message received within ${timeout}ms`));
      }, timeout);

      this.messageWaiters.push(waiter);
    });
  }

  /** Wait for the connection to close (rejects after `timeout` ms). */
  async waitForClose(timeout = 5000): Promise<{ code?: number; reason?: string }> {
    if (this.closeEvent) {
      return this.closeEvent;
    }

    return new Promise<{ code?: number; reason?: string }>((resolve, reject) => {
      const waiter = (event: { code?: number; reason?: string }): void => {
        clearTimeout(timer);
        resolve(event);
      };

      const timer = setTimeout(() => {
        const index = this.closeWaiters.indexOf(waiter);
        if (index !== -1) this.closeWaiters.splice(index, 1);
        reject(new Error(`WebSocket: connection did not close within ${timeout}ms`));
      }, timeout);

      this.closeWaiters.push(waiter);
    });
  }

  /** Assert the next message equals `expected`. */
  async assertMessage(expected: string, timeout = 5000): Promise<void> {
    const data = await this.waitForMessage(timeout);
    const message = typeof data === 'string' ? data : '[ArrayBuffer]';
    expect(message, `Expected WebSocket message "${expected}", got "${message}"`).toBe(expected);
  }

  /** Assert the connection closes, optionally with `expectedCode`. */
  async assertClosed(expectedCode?: number, timeout = 5000): Promise<void> {
    const event = await this.waitForClose(timeout);
    if (expectedCode !== undefined) {
      expect(event.code, `Expected close code ${expectedCode}, got ${event.code}`).toBe(
        expectedCode,
      );
    }
  }
}
