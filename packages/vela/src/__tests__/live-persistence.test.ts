import { describe, expect, it } from 'vitest';
import { readPersistedSubscriptionRecords } from '../live/live.persistence';

const validRecord = () => ({
  sub: 's1',
  query: 'todos.list',
  args: { listId: 'l1' },
  tags: ['todos:l1'],
  key: 'id',
  identity: {
    principal: { issuer: 'test', subject: 'u1', principalType: 'user' },
    tenantId: 't1',
    expiresAtMs: Date.now() + 60_000,
    roles: ['reader'],
    claims: { project: 'p1' },
  },
});

describe('persisted live subscription reconstruction', () => {
  it('constructs fresh known fields and discards volatile baselines and extra fields', () => {
    const source = validRecord();
    const restored = readPersistedSubscriptionRecords([
      { ...source, lastJson: 'malformed JSON', lastCursor: -1, unexpected: true },
    ]);
    expect(restored).toEqual([source]);
    expect(restored[0]).not.toBe(source);
    expect(restored[0]).not.toHaveProperty('lastJson');
    expect(restored[0]).not.toHaveProperty('lastCursor');
    expect(restored[0]).not.toHaveProperty('unexpected');
  });

  it('copies tags and nested identity claims so source mutation cannot rewrite authorization', () => {
    const source = validRecord();
    const restored = readPersistedSubscriptionRecords([source]);
    source.tags.push('other');
    source.identity.roles.push('admin');
    source.identity.claims.project = 'different';
    expect(restored[0]?.tags).toEqual(['todos:l1']);
    expect(restored[0]?.identity?.roles).toEqual(['reader']);
    expect(restored[0]?.identity?.claims).toEqual({ project: 'p1' });
  });

  it('keeps args unknown for the registered query parser rather than inventing a schema', () => {
    const createdAfter = new Date('2026-01-01T00:00:00Z');
    const args = { createdAfter };
    const restored = readPersistedSubscriptionRecords([{ ...validRecord(), args }]);
    expect(restored[0]?.args).toBe(args);
    expect(readPersistedSubscriptionRecords([{ sub: 's', query: 'q', tags: ['t'] }])).toEqual([
      { sub: 's', query: 'q', tags: ['t'], args: undefined },
    ]);
  });

  it.each([
    { sub: '' },
    { sub: 's'.repeat(257) },
    { query: '' },
    { query: 'q'.repeat(257) },
    { key: 1 },
    { key: '' },
    { key: 'k'.repeat(129) },
    { tags: [] },
    { tags: [1] },
    { tags: [''] },
    { tags: ['t\n'] },
    { tags: ['é'.repeat(129)] },
    { tags: Array.from({ length: 1001 }, () => 'tag') },
    { identity: null },
    { identity: [] },
  ])('rejects malformed required or optional fields: %o', (override) => {
    expect(readPersistedSubscriptionRecords([{ ...validRecord(), ...override }])).toEqual([]);
  });

  it.each(['soon', NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed identity expiry %s without dropping only the expiry field',
    (expiresAtMs) => {
      const source = validRecord();
      expect(
        readPersistedSubscriptionRecords([
          { ...source, identity: { ...source.identity, expiresAtMs } },
        ]),
      ).toEqual([]);
    },
  );

  it('retains an elapsed safe expiry for the engine to enforce on delivery', () => {
    expect(
      readPersistedSubscriptionRecords([{ ...validRecord(), identity: { expiresAtMs: 0 } }])[0]
        ?.identity?.expiresAtMs,
    ).toBe(0);
  });

  it('rejects accessors at record, tag, and nested identity boundaries without invoking them', () => {
    let reads = 0;
    const getter = () => {
      reads += 1;
      throw new Error('application getter must not run');
    };
    const record = Object.defineProperty(validRecord(), 'sub', { enumerable: true, get: getter });
    const claims = Object.defineProperty({}, 'secret', { enumerable: true, get: getter });
    const tags = Object.defineProperty([], '0', { enumerable: true, get: getter });
    const attachment = Object.defineProperty([], '0', { enumerable: true, get: getter });
    expect(readPersistedSubscriptionRecords([record])).toEqual([]);
    expect(readPersistedSubscriptionRecords([{ ...validRecord(), identity: { claims } }])).toEqual(
      [],
    );
    expect(readPersistedSubscriptionRecords([{ ...validRecord(), tags }])).toEqual([]);
    expect(readPersistedSubscriptionRecords(attachment)).toEqual([]);
    expect(reads).toBe(0);
  });

  it('rejects identity behavior, prototypes, cycles, dangerous keys, and oversized claims', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const unsafeKey: unknown = JSON.parse('{"__proto__":{"admin":true}}');
    const identities: unknown[] = [
      { claims: () => true },
      { claims: new Date() },
      { claims: cyclic },
      { claims: unsafeKey },
      { claims: 'x'.repeat(64 * 1024) },
    ];
    for (const identity of identities) {
      expect(readPersistedSubscriptionRecords([{ ...validRecord(), identity }])).toEqual([]);
    }
  });

  it('ignores malformed attachment entries without losing independently valid records', () => {
    const valid = validRecord();
    expect(readPersistedSubscriptionRecords([null, false, {}, valid])).toEqual([valid]);
    expect(readPersistedSubscriptionRecords(undefined)).toEqual([]);
    expect(readPersistedSubscriptionRecords({ records: [valid] })).toEqual([]);
  });
});
