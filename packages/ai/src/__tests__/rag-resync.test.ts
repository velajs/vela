import { describe, expect, it } from 'vitest';
import { defineRag, memoryVectors } from '../rag';
import type { RagTextStore, RagVectors } from '../rag';
import { countingEmbedder, memoryTextStore, pipeSplitter } from './support';

describe('defineRag — content-hash re-sync skip', () => {
  it('re-syncing unchanged text skips embedding and writes', async () => {
    const embedder = countingEmbedder();
    const rag = defineRag({
      name: 'resync-skip',
      vectors: memoryVectors(),
      embed: embedder.embed,
      chunk: pipeSplitter,
      allowSharedNamespace: true,
    });

    const first = await rag.sync([{ id: 'doc', text: 'alpha|beta|gamma' }]);
    expect(first[0]?.unchanged).toBe(false);
    expect(first[0]?.chunks).toBe(3);

    const afterFirst = embedder.callCount();
    expect(afterFirst).toBe(3); // one embed per chunk

    const second = await rag.sync([{ id: 'doc', text: 'alpha|beta|gamma' }]);
    expect(second[0]?.unchanged).toBe(true);
    expect(second[0]?.chunks).toBe(3);

    // No further embedding happened on the unchanged re-sync.
    expect(embedder.callCount()).toBe(afterFirst);
  });

  it('re-syncing changed text re-embeds', async () => {
    const embedder = countingEmbedder();
    const rag = defineRag({
      name: 'resync-changed',
      vectors: memoryVectors(),
      embed: embedder.embed,
      chunk: pipeSplitter,
      allowSharedNamespace: true,
    });

    await rag.sync([{ id: 'doc', text: 'alpha|beta' }]);
    const afterFirst = embedder.callCount();

    const changed = await rag.sync([{ id: 'doc', text: 'alpha|delta' }]);
    expect(changed[0]?.unchanged).toBe(false);
    expect(embedder.callCount()).toBeGreaterThan(afterFirst);
  });

  it('a shrinking re-sync deletes the stale trailing chunks', async () => {
    const rag = defineRag({
      name: 'resync-shrink',
      vectors: memoryVectors(),
      embed: countingEmbedder().embed,
      chunk: pipeSplitter,
      allowSharedNamespace: true,
    });

    await rag.sync([{ id: 'doc', text: 'alpha|beta|gamma' }]); // 3 chunks
    await rag.sync([{ id: 'doc', text: 'alpha' }]); // shrinks to 1 chunk

    // The old chunk #2 ('gamma') must no longer be retrievable.
    const found = await rag.retrieve('gamma', { topK: 10 });
    expect(found.chunks.every((chunk) => chunk.text !== 'gamma')).toBe(true);

    const alpha = await rag.retrieve('alpha', { topK: 10 });
    expect(alpha.chunks).toHaveLength(1);
  });

  it('re-indexes unchanged text when ACL metadata changes', async () => {
    const embedder = countingEmbedder();
    const rag = defineRag({
      name: 'resync-acl-change',
      vectors: memoryVectors(),
      embed: embedder.embed,
      allowSharedNamespace: true,
    });

    await rag.sync([{ id: 'doc', text: 'alpha', metadata: { organizationId: 'a' } }]);
    const callsAfterFirstSync = embedder.callCount();

    const changed = await rag.sync([
      { id: 'doc', text: 'alpha', metadata: { organizationId: 'b' } },
    ]);

    expect(changed[0]?.unchanged).toBe(false);
    expect(embedder.callCount()).toBeGreaterThan(callsAfterFirstSync);
    expect((await rag.retrieve('alpha', { filter: { organizationId: 'a' } })).chunks).toHaveLength(
      0,
    );
    expect((await rag.retrieve('alpha', { filter: { organizationId: 'b' } })).chunks).toHaveLength(
      1,
    );
  });

  it('does not commit an ACL fingerprint until every later chunk succeeds', async () => {
    const base = memoryVectors();
    let failChunkTwo = false;
    const vectors: RagVectors = {
      ...base,
      upsert: async (records, options) => {
        if (failChunkTwo && records.some((record) => record.id.endsWith('#2'))) {
          failChunkTwo = false;
          throw new Error('injected chunk failure');
        }
        await base.upsert(records, options);
      },
    };
    const rag = defineRag({
      name: 'resync-acl-failure',
      vectors,
      embed: countingEmbedder().embed,
      chunk: pipeSplitter,
      allowSharedNamespace: true,
    });

    await rag.sync([{ id: 'doc', text: 'alpha|beta|gamma', metadata: { organizationId: 'a' } }]);
    failChunkTwo = true;
    await expect(
      rag.sync([{ id: 'doc', text: 'alpha|beta|gamma', metadata: { organizationId: 'b' } }]),
    ).rejects.toThrow('injected chunk failure');

    const retry = await rag.sync([
      { id: 'doc', text: 'alpha|beta|gamma', metadata: { organizationId: 'b' } },
    ]);
    expect(retry[0]?.unchanged).toBe(false);
    expect(
      (await rag.retrieve('alpha', { topK: 10, filter: { organizationId: 'a' } })).chunks,
    ).toHaveLength(0);
    expect(
      (await rag.retrieve('alpha', { topK: 10, filter: { organizationId: 'b' } })).chunks,
    ).toHaveLength(3);
  });

  it('never exposes newly staged text through the previous ACL generation', async () => {
    const baseText = memoryTextStore();
    let blockWrites = false;
    let releaseWrite: (() => void) | undefined;
    let observedWrite: (() => void) | undefined;
    const writeObserved = new Promise<void>((resolve) => {
      observedWrite = resolve;
    });
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const textStore: RagTextStore = {
      ...baseText,
      put: async (chunks, options) => {
        await baseText.put(chunks, options);
        if (blockWrites) {
          observedWrite?.();
          await writeReleased;
        }
      },
    };
    const rag = defineRag({
      name: 'atomic-text-acl',
      vectors: memoryVectors(),
      textStore,
      embed: countingEmbedder().embed,
      allowSharedNamespace: true,
    });
    await rag.sync([{ id: 'doc', text: 'old text', metadata: { organizationId: 'a' } }]);

    blockWrites = true;
    const replacing = rag.sync([
      { id: 'doc', text: 'new secret', metadata: { organizationId: 'b' } },
    ]);
    await writeObserved;

    const oldReader = await rag.retrieve('text', { filter: { organizationId: 'a' } });
    expect(oldReader.chunks.map((chunk) => chunk.text)).toEqual(['old text']);
    expect((await rag.retrieve('secret', { filter: { organizationId: 'b' } })).chunks).toHaveLength(
      0,
    );

    releaseWrite?.();
    await replacing;
    expect(
      (await rag.retrieve('secret', { filter: { organizationId: 'b' } })).chunks[0]?.text,
    ).toBe('new secret');
  });
});

describe('replacement boundaries', () => {
  it('re-indexes when chunking or text-storage mode changes', async () => {
    const vectors = memoryVectors();
    const common = { vectors, embed: countingEmbedder().embed, allowSharedNamespace: true };
    const doc = [{ id: 'doc', text: 'alpha|beta' }];
    await defineRag(common).sync(doc);
    const split = defineRag({ ...common, chunk: pipeSplitter });
    expect((await split.sync(doc))[0]).toMatchObject({ unchanged: false, chunks: 2 });
    const moved = defineRag({ ...common, chunk: pipeSplitter, textStore: memoryTextStore() });
    expect((await moved.sync(doc))[0]?.unchanged).toBe(false);
    expect((await moved.retrieve('alpha')).chunks).toHaveLength(2);
  });

  it('waits for in-flight writes before rollback and preserves the previous committed source', async () => {
    const base = memoryVectors();
    let fail = false;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const staged: string[] = [];
    let namespace: string | undefined;
    const vectors: RagVectors = {
      ...base,
      upsert: async (records, scope) => {
        if (fail) {
          staged.push(...records.map((record) => record.id));
          namespace = scope.namespace;
          if (records.some((record) => record.id.endsWith('#0'))) throw new Error('write failed');
          entered.resolve();
          await release.promise;
        }
        await base.upsert(records, scope);
      },
    };
    const rag = defineRag({
      vectors,
      embed: countingEmbedder().embed,
      chunk: pipeSplitter,
      allowSharedNamespace: true,
    });
    await rag.sync([{ id: 'doc', text: 'old' }]);
    fail = true;
    const replacing = rag.sync([{ id: 'doc', text: 'new|secret' }]);
    let finished = false;
    const checked = expect(replacing)
      .rejects.toThrow('write failed')
      .then(() => {
        finished = true;
        return undefined;
      });
    await entered.promise;
    // Let an early-rejecting Promise.all implementation reach rollback.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    release.resolve();
    await checked;
    expect(await base.getByIds(staged, { namespace })).toEqual([]);
    expect((await rag.retrieve('old')).chunks.map((chunk) => chunk.text)).toEqual(['old']);
  });
});

it('removes a previously indexed source on an allowed empty replacement', async () => {
  const rag = defineRag({ vectors: memoryVectors(), embed: () => [1], allowSharedNamespace: true });
  await rag.sync([{ id: 'doc', text: 'old' }]);
  await expect(rag.sync([{ id: 'doc', text: '' }], { allowEmpty: false })).rejects.toThrow(
    /zero chunks/,
  );
  expect((await rag.retrieve('old')).chunks).toHaveLength(1);
  expect((await rag.sync([{ id: 'doc', text: '' }]))[0]?.chunks).toBe(0);
  expect((await rag.retrieve('old')).chunks).toHaveLength(0);
});
