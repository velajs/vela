import { afterAll, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AdapterScope } from '@velajs/crud/adapter';
import { drizzleAdapter } from '../adapter';

const table = sqliteTable('items', { id: text().primaryKey() });
const first = createClient({ url: ':memory:' });
const second = createClient({ url: ':memory:' });
afterAll(() => {
  first.close();
  second.close();
});

it('shares only active scopes of the exact native handle', async () => {
  await first.execute('CREATE TABLE items (id TEXT PRIMARY KEY)');
  const db = drizzle(first);
  const owner = drizzleAdapter({ db, table });
  const same = drizzleAdapter({ db, table });
  const foreign = drizzleAdapter({ db: drizzle(second), table });
  let retained: AdapterScope | undefined;
  await owner.requestScope(async (scope) => {
    retained = scope;
    await owner.create({ id: 'one' }, scope);
    expect(await same.readOne({ field: 'id', value: 'one' }, {}, scope)).toEqual({ id: 'one' });
    await expect(foreign.readOne({ field: 'id', value: 'one' }, {}, scope)).rejects.toThrow(
      'Foreign or expired',
    );
  });
  expect(retained).toBeDefined();
  await expect(same.readOne({ field: 'id', value: 'one' }, {}, retained!)).rejects.toThrow(
    'Foreign or expired',
  );
  await expect(owner.readOne({ field: 'id', value: 'one' }, {}, { tx: db })).rejects.toThrow(
    'Foreign or expired',
  );
});
