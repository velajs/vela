import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import {
  createDrizzleReliabilityStore,
  reliabilityPgTable,
} from '../../packages/reliability/src/drizzle';
import { createOutbox } from '../../packages/reliability/src';
import {
  contract,
  ddl,
  parsePayload,
  scope,
} from '../../packages/reliability/src/__tests__/support';

const connectionString = process.env.VELA_POSTGRES_URL;
async function setup() {
  const schema = `delivery_${crypto.randomUUID().replaceAll('-', '')}`;
  const first = new Pool({ connectionString, max: 12 });
  const second = new Pool({ connectionString, max: 12 });
  const pools = [first, second];
  await first.query(`CREATE SCHEMA ${schema}`);
  const tableName = `${schema}.records`;
  try {
    await first.query(ddl(tableName, 'pg'));
  } catch (error) {
    await first.query(`DROP SCHEMA ${schema} CASCADE`);
    await Promise.all(pools.map((pool) => pool.end()));
    throw error;
  }
  const table = reliabilityPgTable('records', schema);
  const store = createDrizzleReliabilityStore({ db: drizzle(first), table, dialect: 'pg' });
  return {
    store,
    other: createDrizzleReliabilityStore({ db: drizzle(second), table, dialect: 'pg' }),
    shift: async (ms: number) => {
      await first.query(
        `UPDATE ${tableName} SET available_at = greatest(0, available_at - $1), lease_until = lease_until - $1, expires_at = expires_at - $1`,
        [ms],
      );
    },
    reopen: async () => {
      const pool = new Pool({ connectionString, max: 4 });
      pools.push(pool);
      return createDrizzleReliabilityStore({ db: drizzle(pool), table, dialect: 'pg' });
    },
    close: async () => {
      try {
        await first.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await Promise.all(pools.map((pool) => pool.end()));
      }
    },
  };
}
describe.skipIf(!connectionString)('live PostgreSQL delivery', () => {
  contract('independent native connections', setup);
  it('makes crash recovery at-least-once rather than claiming exactly-once external effects', async () => {
    const fixture = await setup();
    try {
      const outbox = createOutbox({ store: fixture.store, parsePayload });
      await outbox.enqueue(scope, { id: 'effect', payload: { value: 'message' } });
      const first = (await outbox.claimDue(scope, { leaseMs: 1000 }))[0]!;
      const externalEffects = [first.payload.value];
      // The process dies after the external effect but before durable completion.
      await fixture.shift(2000);
      const restarted = createOutbox({ store: await fixture.reopen(), parsePayload });
      const next = (await restarted.claimDue(scope))[0]!;
      externalEffects.push(next.payload.value);
      await restarted.complete(next);
      expect(externalEffects).toEqual(['message', 'message']);
      await expect(outbox.complete(first)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    } finally {
      await fixture.close();
    }
  });
});
