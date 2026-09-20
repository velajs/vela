import { describe, it, expect, beforeEach } from 'vitest';
import { Controller, Sse, Module, MetadataRegistry } from '@velajs/vela';
import { Test } from '../test.js';
import type { TestingModule } from '../testing-module.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

function eventStream(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of events) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

@Controller('/stream')
class StreamController {
  @Sse('/events')
  events() {
    return eventStream(['event: message\ndata: ping\nid: 1\n\n', 'data: {"n":2}\n\n']);
  }

  @Sse('/plain')
  plain() {
    return eventStream(['data: hello\n\n']);
  }
}

@Module({ controllers: [StreamController] })
class StreamModule {}

async function compile(): Promise<TestingModule> {
  return Test.createTestingModule({ imports: [StreamModule] }).compile();
}

describe('module.sse', () => {
  it('connects and reads a named event with data and id', async () => {
    const module = await compile();
    const sse = await module.sse('/stream/events').connect();
    await sse.assertEvent({ event: 'message', data: 'ping', id: '1' });
  });

  it('reads JSON event data', async () => {
    const module = await compile();
    const sse = await module.sse('/stream/events').connect();
    await sse.waitForEvent(); // skip the first
    await sse.assertJsonEventData({ n: 2 });
  });

  it('assertEventData matches the data field', async () => {
    const module = await compile();
    const sse = await module.sse('/stream/plain').connect();
    await sse.assertEventData('hello');
    await sse.waitForEnd();
  });

  it('collectEvents drains all events until end', async () => {
    const module = await compile();
    const sse = await module.sse('/stream/events').connect();
    const events = await sse.collectEvents();
    expect(events.map((e) => e.data)).toEqual(['ping', '{"n":2}']);
  });

  it('rejects a non-SSE route', async () => {
    const module = await compile();
    await expect(module.sse('/stream/missing').connect()).rejects.toThrow();
  });
});
