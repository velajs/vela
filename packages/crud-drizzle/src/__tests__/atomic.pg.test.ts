import { afterAll, beforeAll, expect, expectTypeOf, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { bigint, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { executeAtomicBatch, requireAtomicBatch } from '@velajs/crud';
import { drizzleAdapter } from '../adapter';
import { DrizzleAuditStore } from '../stores';

const items = pgTable('atomic_items', { id: text().primaryKey(), value: integer().notNull() });
const audit = pgTable('atomic_audit', {
  id: text().primaryKey(),
  timestamp: bigint({ mode: 'number' }).notNull(),
  action: text().notNull(),
  tableName: text().notNull(),
  recordId: text().notNull(),
  userId: text(),
  record: text(),
  previousRecord: text(),
  changes: text(),
  metadata: text(),
});
const client = new PGlite();
const db = drizzle(client);
const row = z.object({ id: z.string(), value: z.number() });
const open = vi.fn();
const adapter = drizzleAdapter({
  db,
  dialect: 'pg',
  table: items,
  parseRow: (v) => row.parse(v),
  onOpenTransaction: open,
});
const batch = requireAtomicBatch(adapter);
const logs = new DrizzleAuditStore(db, audit);
const note = (id: string) =>
  logs.atomic.prepare({
    id,
    timestamp: new Date(),
    action: 'create',
    tableName: 'atomic_items',
    recordId: id,
  });
beforeAll(async () => {
  await client.exec(
    'CREATE TABLE atomic_items (id TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value >= 0)); CREATE TABLE atomic_audit (id TEXT PRIMARY KEY, timestamp BIGINT NOT NULL, action TEXT NOT NULL, "tableName" TEXT NOT NULL, "recordId" TEXT NOT NULL, "userId" TEXT, record TEXT, "previousRecord" TEXT, changes TEXT, metadata TEXT)',
  );
});
afterAll(async () => {
  await client.close();
});
it('commits typed commands under trusted transaction context and rejects later SQL or audit failures', async () => {
  const [created, missing] = await executeAtomicBatch(
    adapter,
    [
      batch.create({ id: 'one', value: 1 }, { audit: note('one') }),
      batch.update({ field: 'id', value: 'missing' }, { value: 2 }, { audit: note('missing') }),
    ],
    { tenantId: 'tenant' },
  );
  expectTypeOf(created).toEqualTypeOf<{ id: string; value: number }>();
  expectTypeOf(missing).toEqualTypeOf<{ id: string; value: number } | null>();
  expect(created).toEqual({ id: 'one', value: 1 });
  expect(missing).toBeNull();
  expect(open).toHaveBeenCalledWith(expect.anything(), { tenantId: 'tenant' });
  expect(await logs.query()).toHaveLength(1);
  await expect(
    batch.execute([
      batch.update({ field: 'id', value: 'one' }, { value: 8 }, { audit: note('update') }),
      batch.create({ id: 'bad', value: -1 }),
    ]),
  ).rejects.toThrow();
  expect(await db.select().from(items)).toEqual([{ id: 'one', value: 1 }]);
  expect(await logs.query()).toHaveLength(1);
  await expect(
    batch.execute([batch.create({ id: 'two', value: 2 }, { audit: note('one') })]),
  ).rejects.toThrow();
  expect(await db.select().from(items)).toEqual([{ id: 'one', value: 1 }]);
  expect(await logs.query()).toHaveLength(1);
});

function negativeTypes() {
  // @ts-expect-error Typed adapters retain their authoring field types.
  batch.create({ id: 1, value: 2 });
  // @ts-expect-error Wrong typed patch value.
  batch.update({ field: 'id', value: 'one' }, { value: 'bad' });
  // @ts-expect-error Ordinary promises cannot masquerade as atomic commands.
  batch.execute([Promise.resolve({ id: 'one', value: 1 })]);
}
void negativeTypes;
