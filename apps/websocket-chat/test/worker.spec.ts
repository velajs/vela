import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const origin = 'http://localhost:8787';

interface Frame {
  event: string;
  data: unknown;
}

/** Buffers every frame from one listener installed before `accept()`, so none is missed. */
function frames(socket: WebSocket) {
  const received: Frame[] = [];
  let wake = (): void => {};
  socket.addEventListener('message', (event) => {
    received.push(JSON.parse(String(event.data)) as Frame);
    wake();
  });
  return {
    received,
    /** Resolves once a frame matches, failing after two seconds. */
    async until(match: (frame: Frame) => boolean): Promise<Frame> {
      const deadline = Date.now() + 2_000;
      for (;;) {
        const found = received.find(match);
        if (found) return found;
        if (Date.now() > deadline)
          throw new Error(`no matching frame in ${JSON.stringify(received)}`);
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 50);
        });
      }
    },
  };
}

describe('websocket-chat compiled by Oxc under workerd', () => {
  it('serves the chat page', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${origin}/`), env, ctx);
    const page = await response.text();
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(page).toContain('Vela WebSocket');
  });

  it('upgrades into the ChatRoom Durable Object and broadcasts chat to the room', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${origin}/rooms/general/ws`, { headers: { origin, upgrade: 'websocket' } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error('the upgrade returned no WebSocket');
    const reader = frames(socket);
    socket.accept();

    // ChatGateway receives its server through @WebSocketServer(), a parameter
    // decorator that Oxc compiles as a legacy decorator.
    const greeting = await reader.until((frame) => frame.event === 'system');
    expect(greeting.data).toMatchObject({ text: expect.stringMatching(/^you are /) });

    socket.send(JSON.stringify({ event: 'chat', data: { text: 'hello room' } }));
    await expect(reader.until((frame) => frame.event === 'ack')).resolves.toEqual({
      event: 'ack',
      data: { ok: true },
    });
    const chat = await reader.until((frame) => frame.event === 'chat');
    expect(chat.data).toMatchObject({ text: 'hello room' });
    socket.close(1000, 'done');
  });
});
