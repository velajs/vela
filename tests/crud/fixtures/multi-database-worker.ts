import { DurableObject } from 'cloudflare:workers';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import {
  defineModel,
  defineResource,
  crudTransaction,
  type CrudTransactionScope,
} from '../../../packages/crud/dist/index.js';
import { durableObjectSqliteAdapter } from '../../../packages/crud-durable-objects/dist/index.js';
import worker from '../../../apps/multi-database/src/worker';
import { createDatabases, type Env as DatabaseEnv } from '../../../apps/multi-database/src/app';

async function rejects(work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return false;
  } catch {
    return true;
  }
}
const schema = z.object({ id: z.string(), title: z.string() });
const table = (name: string) =>
  sqliteTable(name, { id: text().primaryKey(), title: text().notNull() });

export class ComposedDatabase extends DurableObject {
  override async fetch(): Promise<Response> {
    this.ctx.storage.sql.exec('CREATE TABLE first (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
    this.ctx.storage.sql.exec('CREATE TABLE second (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
    const first = durableObjectSqliteAdapter({ storage: this.ctx.storage, table: table('first') });
    const second = durableObjectSqliteAdapter({
      storage: this.ctx.storage,
      table: table('second'),
    });
    const events: string[] = [];
    const a = defineResource('item', {
      model: defineModel({
        name: 'item',
        tableName: 'first',
        schema,
        timestamps: false,
        id: 'client',
      }),
      adapter: first,
      afterCommit: () => {
        events.push('a');
      },
    });
    const b = defineResource('item', {
      model: defineModel({
        name: 'item',
        tableName: 'second',
        schema,
        timestamps: false,
        id: 'client',
      }),
      adapter: second,
      afterCommit: () => {
        events.push('b');
      },
    });
    const write = async (transaction: CrudTransactionScope, id: string) => {
      await a.execute('create', { transaction, body: { id, title: 'first' } });
      await b.execute('create', { transaction, body: { id, title: 'second' } });
    };
    const rollback = await rejects(() =>
      crudTransaction(first, {}, async (transaction) => {
        await write(transaction, 'bad');
        throw new Error('abort');
      }),
    );
    const empty =
      this.ctx.storage.sql.exec('SELECT * FROM first').toArray().length === 0 &&
      this.ctx.storage.sql.exec('SELECT * FROM second').toArray().length === 0;
    const quiet = events.length === 0;
    let retained: CrudTransactionScope | undefined;
    await crudTransaction(first, {}, async (transaction) => {
      retained = transaction;
      await write(transaction, 'good');
    });
    const committed =
      this.ctx.storage.sql.exec('SELECT * FROM first').toArray().length === 1 &&
      this.ctx.storage.sql.exec('SELECT * FROM second').toArray().length === 1;
    const expired = await rejects(() => a.execute('list', { transaction: retained }));
    return Response.json({
      rollback,
      empty,
      quiet,
      committed,
      expired,
      ordered: events.join(',') === 'a,b',
    });
  }
}
interface Env extends DatabaseEnv {
  OBJECTS: DurableObjectNamespace;
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/object-check')
      return env.OBJECTS.get(env.OBJECTS.idFromName(crypto.randomUUID())).fetch(request);
    if (path === '/capabilities') {
      const databases = createDatabases(env);
      const primary = databases.get('primary').resources.item.adapter;
      const other = databases.get('analytics').resources.item.adapter;
      let callbackRan = false;
      const d1Rejected = await rejects(() =>
        crudTransaction(primary, {}, async () => {
          callbackRan = true;
        }),
      );
      let foreign = false;
      const escaped = await primary.requestScope(async (scope) => {
        foreign = await rejects(() => other.readOne({ field: 'id', value: 'same' }, {}, scope));
        return scope;
      });
      const expired = await rejects(() =>
        primary.readOne({ field: 'id', value: 'same' }, {}, escaped),
      );
      return Response.json({ d1Rejected, callbackSkipped: !callbackRan, foreign, expired });
    }
    return worker.fetch!(request, env, ctx);
  },
};
