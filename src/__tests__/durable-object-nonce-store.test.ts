import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  durableObjectNonceStore,
  VelaNonceDurableObject,
  type DurableObjectNonceNamespace,
} from '../nonce/durable-object-nonce.store';

interface QueryCall {
  query: string;
  bindings: unknown[];
}

function sqliteState(): {
  state: DurableObjectState;
  queries: QueryCall[];
  close(): void;
} {
  const db = new DatabaseSync(':memory:');
  const queries: QueryCall[] = [];
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      queries.push({ query, bindings });
      const returnsRows = /^\s*SELECT\b/i.test(query) || /\bRETURNING\b/i.test(query);
      if (returnsRows) {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows };
      }
      if (bindings.length > 0) db.prepare(query).run(...(bindings as never[]));
      else db.exec(query);
      return { toArray: () => [] };
    },
  };
  return {
    state: { storage: { sql } } as unknown as DurableObjectState,
    queries,
    close: () => db.close(),
  };
}

const databases: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of databases.splice(0)) close();
});

function future(seconds = 30): number {
  return Math.floor(Date.now() / 1_000) + seconds;
}

describe('durableObjectNonceStore', () => {
  it('resolves the binding lazily and scopes the DO by the explicit app namespace', async () => {
    const claim = vi.fn().mockResolvedValue(true);
    const idFromName = vi.fn((name: string) => ({ name }));
    const get = vi.fn(() => ({ claim }));
    const binding = vi.fn(
      async () => ({ idFromName, get }) as unknown as DurableObjectNonceNamespace,
    );
    const store = durableObjectNonceStore({ appNamespace: 'orders-api:prod', binding });

    expect(binding).not.toHaveBeenCalled();
    await expect(store.claim('e2b64015-a138-4bee-9db6-642bf4009ed0', future())).resolves.toBe(true);

    expect(binding).toHaveBeenCalledOnce();
    expect(idFromName).toHaveBeenCalledWith('vela:nonce:v1:orders-api:prod');
    expect(get).toHaveBeenCalledWith({ name: 'vela:nonce:v1:orders-api:prod' });
    expect(claim).toHaveBeenCalledWith('e2b64015-a138-4bee-9db6-642bf4009ed0', expect.any(Number));
  });

  it('accepts only a literal true RPC verdict and denies binding failures', async () => {
    const result = vi.fn().mockResolvedValue({ claimed: true });
    const namespace = {
      idFromName: () => ({ id: 'x' }),
      get: () => ({ claim: result }),
    } as unknown as DurableObjectNonceNamespace;
    const store = durableObjectNonceStore({ appNamespace: 'app:test', binding: () => namespace });

    await expect(store.claim('nonce-1', future())).resolves.toBe(false);
    result.mockResolvedValueOnce(true);
    await expect(store.claim('nonce-2', future())).resolves.toBe(true);

    const unavailable = durableObjectNonceStore({
      appNamespace: 'app:test',
      binding: () => {
        throw new Error('binding unavailable');
      },
    });
    await expect(unavailable.claim('nonce-3', future())).resolves.toBe(false);
  });

  it('rejects invalid nonce/expiry input before resolving the binding', async () => {
    const binding = vi.fn();
    const store = durableObjectNonceStore({ appNamespace: 'app:test', binding });
    const validExpiry = future();

    await expect(store.claim('', validExpiry)).resolves.toBe(false);
    await expect(store.claim(' padded ', validExpiry)).resolves.toBe(false);
    await expect(store.claim('control\nvalue', validExpiry)).resolves.toBe(false);
    await expect(store.claim('x'.repeat(513), validExpiry)).resolves.toBe(false);
    await expect(store.claim('nonce', Number.NaN)).resolves.toBe(false);
    await expect(store.claim('nonce', Number.POSITIVE_INFINITY)).resolves.toBe(false);
    await expect(store.claim('nonce', validExpiry + 0.5)).resolves.toBe(false);
    await expect(store.claim('nonce', Math.floor(Date.now() / 1_000) - 1)).resolves.toBe(false);
    expect(binding).not.toHaveBeenCalled();
  });

  it('requires a bounded canonical application namespace and a lazy resolver', () => {
    expect(() => durableObjectNonceStore({ appNamespace: '', binding: vi.fn() })).toThrow(
      /appNamespace/,
    );
    expect(() => durableObjectNonceStore({ appNamespace: ' app ', binding: vi.fn() })).toThrow(
      /appNamespace/,
    );
    expect(() =>
      durableObjectNonceStore({ appNamespace: 'x'.repeat(129), binding: vi.fn() }),
    ).toThrow(/appNamespace/);
    expect(() =>
      durableObjectNonceStore({
        appNamespace: 'app:test',
        binding: undefined as unknown as () => DurableObjectNonceNamespace,
      }),
    ).toThrow(/lazy/);
  });
});

describe('VelaNonceDurableObject SQLite claims', () => {
  it('atomically grants the first claim and denies replay, including concurrent calls', async () => {
    const database = sqliteState();
    databases.push(database.close);
    const durable = new VelaNonceDurableObject(database.state, {});
    const expiry = future();

    await expect(durable.claim('one-time', expiry)).resolves.toBe(true);
    await expect(durable.claim('one-time', expiry)).resolves.toBe(false);

    const simultaneous = await Promise.all([
      durable.claim('concurrent', expiry),
      durable.claim('concurrent', expiry),
      durable.claim('concurrent', expiry),
    ]);
    expect(simultaneous.filter(Boolean)).toHaveLength(1);

    const insert = database.queries.find((call) =>
      /INSERT INTO __vela_nonce_claims/.test(call.query),
    );
    expect(insert?.query).toMatch(/ON CONFLICT\(nonce\) DO NOTHING RETURNING nonce, expires_at/);
  });

  it('retains a nonce through its accepted expiry second, then cleans and permits reuse', async () => {
    const database = sqliteState();
    databases.push(database.close);
    const durable = new VelaNonceDurableObject(database.state, {});
    const now = 2_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now * 1_000);

    await expect(durable.claim('reusable-after-expiry', now)).resolves.toBe(true);
    await expect(durable.claim('reusable-after-expiry', now)).resolves.toBe(false);

    vi.mocked(Date.now).mockReturnValue((now + 1) * 1_000);
    await expect(durable.claim('reusable-after-expiry', now + 30)).resolves.toBe(true);
    const cleanup = database.queries.find((call) =>
      /DELETE FROM __vela_nonce_claims/.test(call.query),
    );
    expect(cleanup?.bindings).toEqual([now, 1_024]);
  });

  it('fails closed for malformed SQLite results, invalid input, and missing SQLite storage', async () => {
    const sql = {
      exec(query: string) {
        if (/INSERT INTO/.test(query)) {
          return { toArray: () => [{ nonce: 'nonce', expires_at: 'not-an-integer' }] };
        }
        return { toArray: () => [] };
      },
    };
    const malformed = new VelaNonceDurableObject(
      { storage: { sql } } as unknown as DurableObjectState,
      {},
    );
    await expect(malformed.claim('nonce', future())).resolves.toBe(false);
    await expect(malformed.claim('nonce', Number.NaN)).resolves.toBe(false);

    const nonSqlite = new VelaNonceDurableObject(
      { storage: {} } as unknown as DurableObjectState,
      {},
    );
    await expect(nonSqlite.claim('nonce', future())).resolves.toBe(false);
  });
});
