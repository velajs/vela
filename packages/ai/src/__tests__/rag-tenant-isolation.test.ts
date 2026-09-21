import { describe, expect, it } from 'vitest';
import { defineRag, memoryVectors } from '../rag';
import type { RagConfig, RagNamespaceResolver } from '../rag';
import { keywordEmbedder } from './support';

const trustedTenantResolver: RagNamespaceResolver = ({ selector, auth }) => {
  if (auth === null || typeof auth !== 'object') {
    throw new Error('missing trusted tenant identity');
  }
  const descriptor = Object.getOwnPropertyDescriptor(auth, 'tenantId');
  const tenantId = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  if (typeof tenantId !== 'string') {
    throw new Error('missing trusted tenant identity');
  }
  if (selector !== undefined && selector !== tenantId) {
    throw new Error('tenant selector is not a membership');
  }
  return tenantId;
};

describe('defineRag — tenant isolation (fail closed)', () => {
  it('cross-namespace retrieval returns nothing', async () => {
    const rag = defineRag({
      name: 'iso-cross',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      resolveNamespace: trustedTenantResolver,
    });

    await rag.sync([{ id: 'secret', text: 'alpha beta gamma' }], {
      namespace: 'tenant-a',
      auth: { tenantId: 'tenant-a' },
    });

    // Same query, different tenant → zero results (the store is namespace-scoped).
    const other = await rag.retrieve('alpha', {
      namespace: 'tenant-b',
      auth: { tenantId: 'tenant-b' },
      topK: 10,
    });
    expect(other.chunks).toHaveLength(0);
    expect(other.sources).toHaveLength(0);

    // The owning tenant still sees its own chunks.
    const own = await rag.retrieve('alpha', {
      namespace: 'tenant-a',
      auth: { tenantId: 'tenant-a' },
      topK: 10,
    });
    expect(own.chunks.length).toBeGreaterThan(0);
  });

  it('treats route namespace values as selectors and verifies trusted membership', async () => {
    const rag = defineRag({
      name: 'iso-selector',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      resolveNamespace: trustedTenantResolver,
    });

    await expect(
      rag.retrieve('alpha', {
        namespace: 'tenant-b',
        auth: { tenantId: 'tenant-a' },
      }),
    ).rejects.toThrow(/not a membership/);
  });

  it('rejects raw namespace selectors when no trusted resolver is configured', async () => {
    const rag = defineRag({
      name: 'iso-raw-selector',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      allowSharedNamespace: true,
    });

    await expect(rag.retrieve('alpha', { namespace: 'tenant-a' })).rejects.toThrow(
      /untrusted selectors/,
    );
  });

  it('an RLS filter is merged over the caller filter — a caller can never widen access', async () => {
    const rlsFilter: NonNullable<RagConfig['rlsFilter']> = (auth) => ({
      org: (auth as { org: string }).org,
    });

    const rag = defineRag({
      name: 'iso-rls',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      allowSharedNamespace: true,
      rlsFilter,
    });

    await rag.sync([
      { id: 'mine', text: 'alpha beta', metadata: { org: 'a' } },
      { id: 'theirs', text: 'alpha beta', metadata: { org: 'b' } },
    ]);

    // The caller tries to widen to org 'b'; RLS pins them to their own org 'a'.
    const result = await rag.retrieve('alpha', {
      auth: { org: 'a' },
      filter: { org: 'b' },
      topK: 10,
    });

    const orgs = result.chunks.map((chunk) => chunk.metadata?.['org']);
    expect(orgs.every((org) => org === 'a')).toBe(true);
    expect(result.sources.map((source) => source.id)).toEqual(['mine']);
  });

  it('requireNamespace throws (never silently touches the shared space)', async () => {
    const rag = defineRag({
      name: 'iso-require',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      requireNamespace: true,
    });

    await expect(rag.sync([{ id: 'x', text: 'alpha' }])).rejects.toThrow(
      /requires a non-empty namespace/,
    );
    await expect(rag.retrieve('alpha')).rejects.toThrow(/requires a non-empty namespace/);
    await expect(rag.remove('x')).rejects.toThrow(/requires a non-empty namespace/);
    await expect(rag.retrieve('alpha', { namespace: '   ' })).rejects.toThrow(
      /untrusted selectors/,
    );
  });

  it('denies the shared namespace unless it is explicitly enabled', async () => {
    const rag = defineRag({
      name: 'iso-shared-denied',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
    });

    await expect(rag.sync([{ id: 'x', text: 'alpha' }])).rejects.toThrow(
      /requires a non-empty namespace/,
    );
  });

  it('allows an explicitly configured single-tenant shared namespace', async () => {
    const rag = defineRag({
      name: 'iso-shared-allowed',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      allowSharedNamespace: true,
    });

    await rag.sync([{ id: 'x', text: 'alpha' }]);
    expect((await rag.retrieve('alpha')).sources.map((source) => source.id)).toEqual(['x']);
  });

  it('keeps an explicit NUL namespace isolated from the shared partition', async () => {
    const rag = defineRag({
      name: 'iso-sentinel',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      allowSharedNamespace: true,
      resolveNamespace: ({ selector }) => selector,
    });
    await rag.sync([{ id: 'shared', text: 'shared-only' }]);
    await rag.sync([{ id: 'tenant', text: 'tenant-only' }], { namespace: '\0shared' });

    expect((await rag.retrieve('shared-only')).sources.map((source) => source.id)).toEqual([
      'shared',
    ]);
    expect(
      (await rag.retrieve('tenant-only', { namespace: '\0shared' })).sources.map(
        (source) => source.id,
      ),
    ).toEqual(['tenant']);
  });

  it('does not resolve inherited named filters', async () => {
    const inherited = Object.create({
      admin: { filter: { role: 'admin' } },
    }) as NonNullable<RagConfig['filters']>;
    const rag = defineRag({
      name: 'iso-inherited-filter',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      allowSharedNamespace: true,
      filters: inherited,
    });

    await expect(rag.retrieve('alpha', { filter: 'admin' })).rejects.toThrow(
      /unknown named filter/,
    );
  });
});

it('preserves maximum-size canonical tenant and source identifiers without ambiguous encoding', async () => {
  const tenant = '\0'.repeat(512);
  const source = '\0'.repeat(512);
  const rag = defineRag({
    vectors: memoryVectors(),
    embed: () => [1],
    resolveNamespace: () => tenant,
  });
  await rag.sync([{ id: source, text: 'private' }]);
  expect((await rag.retrieve('private')).sources.map((entry) => entry.id)).toEqual([source]);
});

it.each(['', ' tenant', 'tenant ', '  '])(
  'rejects noncanonical resolved namespace %j',
  async (namespace) => {
    const rag = defineRag({
      vectors: memoryVectors(),
      embed: () => [1],
      resolveNamespace: () => namespace,
    });
    await expect(rag.retrieve('private')).rejects.toThrow(/canonical/);
  },
);
