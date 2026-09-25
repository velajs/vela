// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import { env } from 'cloudflare:test';
import type { Pipeline } from 'cloudflare:pipelines';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createPipelinesWriter } from '../../pipelines';

describe('Pipelines writer under workerd', () => {
  it('awaits the local native binding with transformed JSON records', async () => {
    // This proves local binding compatibility only. Miniflare's send() is a
    // no-op: it cannot prove remote acceptance, schema enforcement or storage.
    const binding: Pipeline = env.PIPELINES_TEST_STREAM;
    const writer = createPipelinesWriter(binding, {
      schema: z.object({ id: z.string(), count: z.string().transform(Number) }),
    });
    await expect(writer.send([{ id: 'sample', count: '2' }])).resolves.toBeUndefined();
    await expect(binding.send([{ id: 'native', count: 3 }])).resolves.toBeUndefined();
    const json = createPipelinesWriter(binding, { schema: z.object({ payload: z.unknown() }) });
    await expect(json.send([{ payload: Object.create(null) }])).resolves.toBeUndefined();
    await expect(
      json.send([{ payload: JSON.parse('{"__proto__":{"safe":true}}') }]),
    ).resolves.toBeUndefined();
  });

  it('rejects invalid transformed JSON and UTF-8 payloads before the native call', async () => {
    const binding: Pipeline = env.PIPELINES_TEST_STREAM;
    const send = vi.fn((records: Record<string, unknown>[]) => binding.send(records));
    const writer = createPipelinesWriter(
      { send },
      {
        schema: z.object({ payload: z.unknown() }),
      },
    );
    await expect(writer.send([{ payload: 'valid' }, { payload: [NaN] }])).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(writer.send([{ payload: 'é'.repeat(2_500_000) }])).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(send).not.toHaveBeenCalled();
  });
});
