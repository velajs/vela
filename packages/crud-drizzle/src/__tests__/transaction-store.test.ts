import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { drizzleAdapter } from '../adapter';
import { drizzleTransactionStore } from '../transaction';

it('checks the native owner and lifetime on every bound store operation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vela-transaction-'));
  const client = createClient({ url: `file:${join(dir, 'database.db')}` });
  const db = drizzle(client);
  const table = sqliteTable('entries', { id: text().primaryKey() });
  await client.execute('CREATE TABLE entries (id TEXT PRIMARY KEY)');
  const adapter = drizzleAdapter({ db, table });
  const binding = drizzleTransactionStore(db, (run) => ({
    insert: (id: string) =>
      run(async (native) => {
        await native.insert(table).values({ id });
      }),
  }));
  let retained!: ReturnType<typeof binding.bind>;
  try {
    await adapter.transaction(async (scope) => {
      retained = binding.bind(scope, {}, () => {});
      await retained.insert('one');
      expect(() => binding.bind({ tx: db }, {}, () => {})).toThrow('Foreign or expired');
    });
    await expect(retained.insert('late')).rejects.toThrow('Foreign or expired');
    expect(await db.select().from(table)).toEqual([{ id: 'one' }]);
  } finally {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('reports a caught native or fence error through the lifecycle observer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vela-transaction-'));
  const client = createClient({ url: `file:${join(dir, 'database.db')}` });
  const db = drizzle(client);
  const table = sqliteTable('entries', { id: text().primaryKey() });
  const adapter = drizzleAdapter({ db, table });
  const errors: unknown[] = [];
  const binding = drizzleTransactionStore(db, (run) => ({
    complete: () =>
      run(async () => {
        throw new Error('lease lost');
      }),
  }));
  try {
    await adapter.transaction(async (scope) => {
      const store = binding.bind(scope, {}, (error) => errors.push(error));
      await store.complete().catch(() => undefined);
    });
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('lease lost');
  } finally {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
