import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineModel, defineResource } from '@velajs/crud';
import { drizzleAdapter } from '@velajs/crud-drizzle';

const connectionString = process.env.VELA_POSTGRES_URL;
describe.skipIf(!connectionString)('PostgreSQL ETag locking', () => {
  const namespace = `vela_etag_${crypto.randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({
    connectionString,
    max: 4,
    options: `-c search_path=${namespace} -c statement_timeout=5000`,
  });
  const table = pgTable('items', { id: text().primaryKey(), label: text().notNull() });
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${namespace}`);
    await pool.query('CREATE TABLE items (id text PRIMARY KEY, label text NOT NULL)');
  });
  afterAll(async () => {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
    } finally {
      await pool.end();
    }
  });

  it('commits exactly one update when two requests use the same If-Match', async () => {
    await pool.query("INSERT INTO items VALUES ('a', 'original')");
    const adapter = drizzleAdapter({ db: drizzle(pool), table, dialect: 'pg' });
    const bothReading = Promise.withResolvers<void>();
    let attempts = 0;
    let updating = false;
    const readOne = adapter.runtime.readOne;
    adapter.runtime.readOne = async (...args) => {
      if (updating && ++attempts === 2) bothReading.resolve();
      return readOne(...args);
    };
    // Force both update requests to reach their lookup before the first writes.
    // Without SELECT FOR UPDATE, both would validate the old tag and commit.
    const beforeUpdate = vi.fn(async () => {
      await bothReading.promise;
    });
    const resource = defineResource('items', {
      model: defineModel({
        name: 'item',
        tableName: 'items',
        timestamps: false,
        schema: z.object({ id: z.string(), label: z.string() }),
      }),
      adapter,
      etag: true,
      hooks: { beforeUpdate },
    });
    const initial = await resource.execute('read', { id: 'a' });
    updating = true;
    const outcomes = await Promise.allSettled(
      ['first', 'second'].map((label) =>
        resource.execute('update', {
          id: 'a',
          body: { label },
          request: new Request('http://test/', { headers: { 'If-Match': initial.headers!.ETag! } }),
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(failure).toMatchObject({ reason: { statusCode: 409 } });
    expect(beforeUpdate).toHaveBeenCalledTimes(1);
    const winner = outcomes[0]!.status === 'fulfilled' ? 'first' : 'second';
    expect((await pool.query("SELECT label FROM items WHERE id = 'a'")).rows).toEqual([
      { label: winner },
    ]);
  });
});
