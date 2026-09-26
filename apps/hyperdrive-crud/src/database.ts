import type { ExecutionLifetime } from '@velajs/vela';
import { acquireCrudDatabases, createCrudDatabaseRegistry, defineCrudDatabase } from '@velajs/crud';
import { drizzleAdapter } from '@velajs/crud-drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import { items, itemModel, itemSchema } from './schema.js';

/** Native Hyperdrive binding; no adapter for a second database protocol. */
export function acquireDatabase(
  binding: Pick<Hyperdrive, 'connectionString'>,
  lifetime: ExecutionLifetime,
) {
  if (typeof binding?.connectionString !== 'string' || !binding.connectionString.trim())
    throw new TypeError('Hyperdrive connectionString is required');
  return acquireCrudDatabases({
    signal: lifetime.signal,
    // Allocation returns synchronously, so connect failure is inside the owned boundary.
    acquire: () =>
      new Client({
        connectionString: binding.connectionString,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 10_000,
      }),
    create: async (client) => {
      await client.connect();
      const db = drizzle(client, { schema: { items } });
      return createCrudDatabaseRegistry([
        defineCrudDatabase('primary', {
          handle: db,
          resources: {
            item: {
              model: itemModel,
              adapter: drizzleAdapter({
                db,
                dialect: 'pg',
                table: items,
                parseRow: (value) => itemSchema.parse(value),
              }),
            },
          },
        }),
      ]);
    },
    release: (client) => client.end(),
  });
}
