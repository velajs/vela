import { asSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { defineRag, memoryVectors } from '../rag';

const execution = { toolCallId: 'search', messages: [], context: {} };

describe('request-bound RAG tools', () => {
  const rag = () =>
    defineRag({
      vectors: memoryVectors(),
      embed: () => [1],
      resolveNamespace: ({ auth, selector }) => {
        if (typeof auth !== 'string' || (selector !== undefined && selector !== auth))
          throw new Error('denied');
        return auth;
      },
    });

  it('validates tool inputs at the SDK schema boundary without a Zod dependency', async () => {
    const schema = asSchema(rag().asTool({ auth: 'a' }).inputSchema);
    for (const input of [
      null,
      {},
      { query: 1 },
      { query: 'ok', namespace: 'b' },
      { query: '🌎'.repeat(9000) },
    ]) {
      expect(await schema.validate?.(input)).toMatchObject({ success: false });
    }
    expect(await schema.validate?.({ query: 'ok' })).toEqual({
      success: true,
      value: { query: 'ok' },
    });
  });

  it('keeps simultaneous tool scopes isolated and denies a mismatched selector', async () => {
    const index = rag();
    await index.sync([{ id: 'doc', text: 'private a' }], { auth: 'a' });
    await index.sync([{ id: 'doc', text: 'private b' }], { auth: 'b' });
    const a = index.asTool({ auth: 'a' });
    const b = index.asTool({ auth: 'b' });
    const results = await Promise.all([
      a.execute!({ query: 'private' }, execution),
      b.execute!({ query: 'private' }, execution),
    ]);
    expect(results).toMatchObject([
      { chunks: [{ text: 'private a' }] },
      { chunks: [{ text: 'private b' }] },
    ]);
    const denied = index.asTool({ auth: 'a', namespace: 'b' });
    await expect(denied.execute!({ query: 'private' }, execution)).rejects.toThrow('denied');
  });
});
