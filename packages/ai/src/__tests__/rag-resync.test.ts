import { describe, expect, it } from 'vitest';
import { defineRag, memoryVectors, memoryPublications, RagIndexingError } from '../rag';
import type { RagVectors, RagPublicationTransaction } from '../rag';
import { countingEmbedder, pipeSplitter } from './support';

const setup = (vectors = memoryVectors()) => {
  const embedder = countingEmbedder();
  const publications = memoryPublications();
  const config = {
    vectors,
    publications,
    embed: embedder.embed,
    chunk: pipeSplitter,
    allowSharedNamespace: true,
  };
  return { ...config, embedder, rag: defineRag(config), config };
};
const current = async (rag: ReturnType<typeof defineRag>) => (await rag.inspect('doc'))!.revision;

it('uses CAS for replacement, skip, shrink and tombstones', async () => {
  const { rag, embedder } = setup();
  const [first] = await rag.sync([{ id: 'doc', text: 'alpha|beta|gamma' }]);
  expect(first).toMatchObject({ publication: 'published', indexing: { status: 'visible' } });
  await expect(rag.sync([{ id: 'doc', text: 'overwrite' }])).rejects.toThrow(/conflict/);
  const [same] = await rag.sync([
    { id: 'doc', text: 'alpha|beta|gamma', expectedRevision: first!.revision },
  ]);
  expect(same?.unchanged).toBe(true);
  expect(embedder.callCount()).toBe(3);
  const [short] = await rag.sync([{ id: 'doc', text: 'alpha', expectedRevision: first!.revision }]);
  expect((await rag.retrieve('gamma')).chunks.map((c) => c.text)).toEqual(['alpha']);
  const deleted = await rag.remove('doc', { expectedRevision: short!.revision });
  expect(deleted.state).toBe('deleted');
  expect((await rag.retrieve('alpha')).chunks).toEqual([]);
  await expect(
    rag.sync([{ id: 'doc', text: 'old retry', expectedRevision: first!.revision }]),
  ).rejects.toThrow(/conflict/);
  await rag.sync([{ id: 'doc', text: 'new', expectedRevision: deleted.revision }]);
});

it('reconstructs a failed pending attempt after restart; old ACL remains revoked', async () => {
  const base = memoryVectors();
  let fail = false;
  const vectors: RagVectors = {
    ...base,
    async upsert(records, scope) {
      const result = await base.upsert(records, scope);
      if (fail) throw new Error('lost receipt');
      return result;
    },
  };
  const { rag, config } = setup(vectors);
  await rag.sync([{ id: 'doc', text: 'alpha', metadata: { org: 'a' } }]);
  const expectedRevision = await current(rag);
  fail = true;
  await expect(
    rag.sync([{ id: 'doc', text: 'beta', metadata: { org: 'b' }, expectedRevision }]),
  ).rejects.toBeInstanceOf(RagIndexingError);
  expect((await rag.retrieve('alpha', { filter: { org: 'a' } })).chunks).toEqual([]);
  expect((await rag.retrieve('beta', { filter: { org: 'b' } })).chunks).toEqual([]);
  const restarted = defineRag(config);
  const pending = await restarted.inspect('doc');
  expect(pending?.state).toBe('pending');
  fail = false;
  await restarted.reconcile('doc', { revision: pending!.revision });
  expect((await restarted.retrieve('beta', { filter: { org: 'b' } })).chunks[0]?.text).toBe('beta');
  expect((await restarted.retrieve('alpha', { filter: { org: 'a' } })).chunks).toEqual([]);
});

it('rejects concurrent writers and an in-flight sync cannot undo a remove', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const base = memoryVectors();
  const vectors: RagVectors = {
    ...base,
    async upsert(records, scope) {
      entered.resolve();
      await release.promise;
      return base.upsert(records, scope);
    },
  };
  const { rag, config } = setup(vectors);
  const pending = rag.sync([{ id: 'doc', text: 'alpha' }]);
  const checked = expect(pending).rejects.toThrow(/superseded/);
  await entered.promise;
  await expect(defineRag(config).sync([{ id: 'doc', text: 'concurrent' }])).rejects.toThrow(
    /conflict/,
  );
  const deleted = await rag.remove('doc', { expectedRevision: await current(rag) });
  release.resolve();
  await checked;
  expect((await rag.retrieve('alpha')).chunks).toEqual([]);
  await rag.reconcile('doc', { revision: deleted.revision });
});

it('leaves canceled indexing pending; explicit resume works, canceled revisions cannot resurrect', async () => {
  const controller = new AbortController();
  const base = memoryVectors();
  let abort = true;
  const vectors: RagVectors = {
    ...base,
    async upsert(records, scope) {
      const result = await base.upsert(records, scope);
      if (abort) controller.abort();
      return result;
    },
  };
  const { rag } = setup(vectors);
  await expect(
    rag.sync([{ id: 'doc', text: 'alpha' }], { signal: controller.signal }),
  ).rejects.toBeInstanceOf(RagIndexingError);
  expect((await rag.retrieve('alpha')).chunks).toEqual([]);
  abort = false;
  const revision = await current(rag);
  await rag.reconcile('doc', { revision });
  expect((await rag.retrieve('alpha')).chunks).toHaveLength(1);
  const removed = await rag.remove('doc', { expectedRevision: revision });
  await expect(rag.reconcile('doc', { revision })).rejects.toThrow(/conflict/);
  await rag.reconcile('doc', { revision: removed.revision });
});

it('bounds recovery journal scans and does not forget ambiguous cleanup', async () => {
  const base = memoryVectors();
  let fail = false;
  const vectors: RagVectors = {
    ...base,
    async deleteByIds(ids, scope) {
      if (fail) throw new Error('cleanup unavailable');
      return base.deleteByIds(ids, scope);
    },
  };
  const { rag } = setup(vectors);
  for (let i = 0; i < 4; i++)
    await rag.sync([
      {
        id: 'doc',
        text: `alpha ${i}`,
        expectedRevision: (await rag.inspect('doc'))?.revision ?? null,
      },
    ]);
  const tombstone = await rag.remove('doc', { expectedRevision: await current(rag) });
  fail = true;
  await expect(rag.reconcile('doc', { revision: tombstone.revision, limit: 1 })).rejects.toThrow(
    /cleanup unavailable/,
  );
  expect((await rag.retrieve('alpha')).chunks).toEqual([]);
  fail = false;
  const page = await rag.reconcile('doc', { revision: tombstone.revision, limit: 1 });
  expect(page.cleanup).toHaveLength(1);
  expect(page.cursor).toBeDefined();
  const next = await rag.reconcile('doc', {
    revision: tombstone.revision,
    limit: 1,
    after: page.cursor!,
  });
  expect(next.cursor).not.toBe(page.cursor);
});

it('revokes the old generation before embedding and can recover an embedding failure', async () => {
  const publications = memoryPublications();
  const vectors = memoryVectors();
  let fail = false;
  const rag = defineRag({
    publications,
    vectors,
    allowSharedNamespace: true,
    embed: () => {
      if (fail) throw new Error('embed failed');
      return [1];
    },
  });
  await rag.sync([{ id: 'doc', text: 'old', metadata: { role: 'reader' } }]);
  fail = true;
  await expect(
    rag.sync([
      {
        id: 'doc',
        text: 'secret',
        metadata: { role: 'admin' },
        expectedRevision: await current(rag),
      },
    ]),
  ).rejects.toThrow(/embed failed/);
  expect((await rag.inspect('doc'))?.state).toBe('pending');
  fail = false;
  expect((await rag.retrieve('old', { filter: { role: 'reader' } })).chunks).toEqual([]);
});

it('empty replacements revoke and require the previous revision', async () => {
  const rag = defineRag({
    publications: memoryPublications(),
    vectors: memoryVectors(),
    embed: () => [1],
    allowSharedNamespace: true,
  });
  await rag.sync([{ id: 'doc', text: 'old' }]);
  const expectedRevision = await current(rag);
  await expect(
    rag.sync([{ id: 'doc', text: '', expectedRevision }], { allowEmpty: false }),
  ).rejects.toThrow(/zero chunks/);
  expect((await rag.sync([{ id: 'doc', text: '', expectedRevision }]))[0]?.publication).toBe(
    'deleted',
  );
  expect((await rag.retrieve('old')).chunks).toEqual([]);
});

describe('publication transactions', () => {
  it('rolls back failures, detaches values, and closes retained handles', async () => {
    const store = memoryPublications();
    let retained: RagPublicationTransaction | undefined;
    await expect(
      store.transaction({}, async (tx) => {
        await tx.put('key', { value: 1 });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await store.transaction({}, (tx) => tx.get('key'))).toBeUndefined();
    await store.transaction({}, async (tx) => {
      retained = tx;
      await tx.put('key', { value: 2 });
    });
    await expect(retained!.put('key', { value: 3 })).rejects.toThrow(/closed/);
    const value = await store.transaction({}, (tx) => tx.get<{ value: number }>('key'));
    value!.value = 4;
    expect(await store.transaction({}, (tx) => tx.get('key'))).toEqual({ value: 2 });
  });
});

it('recovers a crash after accepted writes but before publication commit', async () => {
  const base = memoryPublications();
  let fail = true;
  const publications: import('../rag').RagPublications = {
    transaction: (scope, body) =>
      base.transaction(scope, (tx) =>
        body({
          ...tx,
          async put(key, value) {
            if (
              fail &&
              key.startsWith('h:') &&
              value &&
              typeof value === 'object' &&
              'state' in value &&
              value.state === 'published'
            )
              throw new Error('commit unavailable');
            await tx.put(key, value);
          },
        }),
      ),
  };
  const rag = defineRag({
    vectors: memoryVectors(),
    publications,
    embed: () => [1],
    allowSharedNamespace: true,
  });
  await expect(rag.sync([{ id: 'doc', text: 'secret' }])).rejects.toThrow('commit unavailable');
  expect((await rag.retrieve('secret')).chunks).toEqual([]);
  fail = false;
  await rag.reconcile('doc', { revision: (await rag.inspect('doc'))!.revision });
  expect((await rag.retrieve('secret')).chunks[0]?.text).toBe('secret');
});

it.each(['head', 'chunk', 'journal'])(
  'fails closed on corrupted persisted %s records',
  async (kind) => {
    const base = memoryPublications();
    let corrupt = false;
    const publications: import('../rag').RagPublications = {
      transaction: (scope, body) =>
        base.transaction(scope, (tx) =>
          body({
            ...tx,
            async get<T>(key: string): Promise<T | undefined> {
              if (
                corrupt &&
                ((kind === 'head' && key.startsWith('h:')) ||
                  (kind === 'chunk' && key.startsWith('c:')))
              )
                return { state: 'published', chunks: Infinity } as T;
              return tx.get<T>(key);
            },
            async list<T>(options: Parameters<RagPublicationTransaction['list']>[0]) {
              const values = await tx.list<T>(options);
              if (corrupt && kind === 'journal')
                return new Map(
                  [...values].map(([key]) => [key, { revision: 'forged', chunks: -1 } as T]),
                );
              return values;
            },
          }),
        ),
    };
    const rag = defineRag({
      publications,
      vectors: memoryVectors(),
      embed: () => [1],
      allowSharedNamespace: true,
    });
    const [created] = await rag.sync([{ id: 'doc', text: 'secret' }]);
    corrupt = true;
    if (kind === 'journal')
      await expect(rag.reconcile('doc', { revision: created!.revision })).rejects.toThrow(
        /corrupt/,
      );
    else await expect(rag.retrieve('secret')).rejects.toThrow(/corrupt/);
  },
);

it('keeps all partially submitted chunks hidden until the whole revision is acknowledged', async () => {
  const base = memoryVectors();
  let batches = 0;
  const vectors: RagVectors = {
    ...base,
    async upsert(records, scope) {
      if (++batches === 2) throw new Error('second batch failed');
      return base.upsert(records, scope);
    },
  };
  const { rag } = setup(vectors);
  await expect(
    rag.sync([{ id: 'doc', text: Array.from({ length: 33 }, () => 'alpha').join('|') }]),
  ).rejects.toThrow(/second batch/);
  expect((await rag.retrieve('alpha', { topK: 50 })).chunks).toEqual([]);
  await rag.reconcile('doc', { revision: await current(rag) });
  expect((await rag.retrieve('alpha', { topK: 50 })).chunks).toHaveLength(33);
});

it.each(['indexing', 'neighbors'])(
  'rejects a valid foreign record stored at another chunk key during %s',
  async (mode) => {
    const base = memoryPublications();
    const records = new Map<string, unknown>();
    let poisonedKey = '';
    let foreign: unknown;
    const publications: import('../rag').RagPublications = {
      transaction: (scope, body) =>
        base.transaction(scope, (tx) =>
          body({
            ...tx,
            async put(key, value) {
              records.set(key, structuredClone(value));
              await tx.put(key, value);
            },
            async get<T>(key: string): Promise<T | undefined> {
              return key === poisonedKey ? (structuredClone(foreign) as T) : tx.get<T>(key);
            },
          }),
        ),
    };
    const vectorBase = memoryVectors();
    let submissions = 0;
    const vectors: RagVectors = {
      ...vectorBase,
      async upsert(values, scope) {
        submissions++;
        return vectorBase.upsert(values, scope);
      },
    };
    const rag = defineRag({
      publications,
      vectors,
      embed: () => [1],
      chunk: pipeSplitter,
      allowSharedNamespace: true,
    });
    const [doc, other] = await rag.sync([
      { id: 'doc', text: 'alpha|beta' },
      { id: 'foreign', text: 'private text' },
    ]);
    foreign = records.get(`c:${other!.ids[0]}`);
    poisonedKey = `c:${doc!.ids[1]}`;
    const before = submissions;
    if (mode === 'indexing') {
      await expect(
        rag.reconcile('doc', { revision: doc!.revision, reindex: true }),
      ).rejects.toThrow(/corrupt chunk identity/);
      expect(submissions).toBe(before);
    } else {
      vectors.query = async () => [{ id: doc!.ids[0]!, score: 1 }];
      await expect(rag.retrieve('q', { chunkContext: { after: 1 } })).rejects.toThrow(
        /corrupt chunk identity/,
      );
    }
  },
);
