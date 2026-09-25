import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { defineModel, defineResource } from '../../../packages/crud/dist/index.js';
import { drizzleAdapter } from '../../../packages/crud-drizzle/dist/index.js';
import { durableObjectSqliteAdapter } from '../../../packages/crud-durable-objects/dist/index.js';
import { TenantRegistry, TenantService } from '../../../packages/tenant/dist/index.js';
import {
  D1TenantRegistryStore,
  tenantSqliteSchema,
} from '../../../packages/tenant/dist/d1/index.js';
import { DurableObjectTenantRegistryStore } from '../../../packages/tenant/dist/durable-objects/index.js';
import { cloudflareCedar } from '../../../packages/authz-cedar/dist/cloudflare/index.js';
import {
  createCedarEngine,
  defineVocabulary,
  t,
  entity,
} from '../../../packages/authz-cedar/dist/index.js';
import { D1PolicyStore, policySqliteSchema } from '../../../packages/authz-cedar/dist/d1/index.js';
import { DurableObjectPolicyStore } from '../../../packages/authz-cedar/dist/durable-objects/index.js';
import { CryptoService, LocalKeyRing } from '../../../packages/crypto/dist/index.js';
import { encryptToR2, decryptFromR2 } from '../../../packages/crypto/dist/files/index.js';
const table = sqliteTable(
  'entries',
  {
    part: text().notNull(),
    id: text().notNull(),
    tenantId: text().notNull(),
    rank: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.part, t.id] })],
);
const schema = z.object({
  part: z.string(),
  id: z.string(),
  tenantId: z.string(),
  rank: z.number(),
});
const model = defineModel({
  name: 'entry',
  tableName: 'entries',
  schema,
  primaryKeys: ['part', 'id'],
  id: 'client',
  multiTenant: true,
  timestamps: false,
});
const principal = { issuer: 'worker', subject: 'u', principalType: 'user' } as const;
const tenant = { id: 'a', name: 'A', status: 'active', settings: {} } as const;
const policyScope = { application: 'app', environment: 'test', tenantId: 'a' };
const audit = () => ({ id: crypto.randomUUID(), actor: 'admin', reason: 'test', at: Date.now() });
const vocabulary = defineVocabulary({
  namespace: 'Edge',
  entities: { User: {}, Doc: { attrs: { rank: t.long() } } },
  actions: { read: { principal: ['User'], resource: ['Doc'] } },
});
const ddl =
  'CREATE TABLE IF NOT EXISTS entries(part TEXT NOT NULL,id TEXT NOT NULL,tenantId TEXT NOT NULL,rank INTEGER NOT NULL,PRIMARY KEY(part,id))';
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function rejected(work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return false;
  } catch {
    return true;
  }
}
export class EdgeObject extends DurableObject {
  async fetch(): Promise<Response> {
    this.ctx.storage.sql.exec(ddl);
    const adapter = durableObjectSqliteAdapter({
      atomicUpsert: true,
      storage: this.ctx.storage,
      table,
      primaryKeys: ['part', 'id'],
    });
    const resource = defineResource('entries', {
      model,
      adapter,
      upsert: { keys: ['part', 'id'] },
    });
    const vars = { tenantId: 'a' };
    await resource.execute('create', { vars, body: { part: 'one', id: 'same', rank: 1 } });
    await resource.execute('create', { vars, body: { part: 'two', id: 'same', rank: 2 } });
    const broken = defineResource('entries', {
      model,
      adapter,
      hooks: {
        afterCreate: () => {
          throw new Error('rollback');
        },
      },
    });
    assert(
      await rejected(() =>
        broken.execute('create', { vars, body: { part: 'bad', id: 'same', rank: 9 } }),
      ),
      'transaction must fail',
    );
    assert(
      await rejected(() => resource.execute('read', { vars, id: { part: 'bad', id: 'same' } })),
      'transaction must roll back',
    );
    const outcomes = await Promise.all(
      [3, 4].map((rank) =>
        resource.execute('upsert', { vars, body: { part: 'upsert', id: 'race', rank } }),
      ),
    );
    assert(
      outcomes.every((o) => o.status === 200 || o.status === 201),
      'upsert results',
    );
    const lookup = schema.parse(
      (await resource.execute('read', { vars, id: { part: 'two', id: 'same' } })).body &&
        this.ctx.storage.sql.exec("SELECT * FROM entries WHERE part='two'").toArray()[0],
    );
    assert(lookup.rank === 2, 'compound lookup');
    const conditional = defineResource('conditional', { model, adapter, etag: true });
    const id = { part: 'two', id: 'same' };
    const current = await conditional.execute('read', { vars, id });
    const updates = await Promise.allSettled(
      [10, 11].map((rank) =>
        conditional.execute('update', {
          vars,
          id,
          body: { rank },
          request: new Request('https://edge.test/', {
            headers: { 'If-Match': current.headers!.ETag! },
          }),
        }),
      ),
    );
    assert(
      updates.filter((result) => result.status === 'fulfilled').length === 1,
      'ETag must commit once',
    );
    assert(
      updates.some((result) => result.status === 'rejected' && result.reason.statusCode === 409),
      'ETag conflict',
    );
    const tenants = new DurableObjectTenantRegistryStore(this.ctx.storage);
    tenants.migrate();
    const registry = new TenantRegistry({ store: tenants, authorize: () => true });
    await registry.save(tenant, null, principal, 'Create');
    const admission = new TenantService({ lookup: tenants, authorize: () => true });
    await admission.admit({ tenantId: 'a', principal });
    await registry.save({ ...tenant, status: 'suspended' }, 1, principal, 'Suspend');
    assert(await rejected(() => admission.admit({ tenantId: 'a', principal })), 'suspension');
    const policies = new DurableObjectPolicyStore(this.ctx.storage);
    policies.migrate();
    assert(
      await policies.put(
        policyScope,
        { policies: { allow: 'permit(principal, action, resource);' } },
        null,
        audit(),
      ),
      'policy creation',
    );
    assert(!(await policies.put(policyScope, { policies: {} }, null, audit())), 'policy CAS');
    return Response.json({
      etag: true,
      rollback: true,
      compound: true,
      upsert: true,
      tenant: true,
      policy: true,
    });
  }
}
interface Env {
  DB: D1Database;
  OBJECTS: DurableObjectNamespace;
  BUCKET: R2Bucket;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/do')
        return env.OBJECTS.get(env.OBJECTS.idFromName(crypto.randomUUID())).fetch(request);
      if (path === '/d1') {
        await env.DB.exec(ddl);
        const adapter = drizzleAdapter({
          atomicUpsert: true,
          db: drizzle(env.DB),
          driver: 'd1',
          table,
          primaryKeys: ['part', 'id'],
        });
        const resource = defineResource('entries', {
            model,
            adapter,
            upsert: { keys: ['part', 'id'] },
          }),
          vars = { tenantId: 'a' };
        await resource.execute('upsert', { vars, body: { part: 'one', id: 'same', rank: 1 } });
        await resource.execute('upsert', { vars, body: { part: 'one', id: 'same', rank: 2 } });
        const row = await env.DB.prepare('SELECT rank FROM entries WHERE part=? AND id=?')
          .bind('one', 'same')
          .first<{ rank: number }>();
        assert(row?.rank === 2, 'atomic D1 batch upsert');
        assert(
          await rejected(() =>
            resource.execute('upsert', {
              vars: { tenantId: 'b' },
              body: { part: 'one', id: 'same', rank: 99 },
            }),
          ),
          'cross-tenant upsert',
        );
        const restricted = defineResource('entries', {
          model,
          adapter,
          authorization: async () => ({
            kind: 'conditional',
            predicate: { op: 'gte', field: 'rank', value: 2 },
          }),
        });
        const page = z
          .object({ result: schema.array(), result_info: z.object({ total_count: z.number() }) })
          .parse((await restricted.execute('list', { vars })).body);
        assert(page.result_info.total_count === 1, 'scoped count');
        assert(
          await rejected(() =>
            restricted.execute('update', {
              vars,
              id: { part: 'one', id: 'wrong' },
              body: { rank: 3 },
            }),
          ),
          'compound mutation',
        );
        for (const sql of tenantSqliteSchema) await env.DB.exec(sql);
        const tenants = new D1TenantRegistryStore(env.DB),
          registry = new TenantRegistry({ store: tenants, authorize: () => true });
        await registry.save(tenant, null, principal, 'Create');
        await registry.save({ ...tenant, status: 'suspended' }, 1, principal, 'Suspend');
        const admission = new TenantService({ lookup: tenants, authorize: () => true });
        assert(
          await rejected(() => admission.admit({ tenantId: 'a', principal })),
          'D1 suspension',
        );
        const audits = await env.DB.prepare('SELECT COUNT(*) AS n FROM vela_tenant_audit').first<{
          n: number;
        }>();
        assert(audits?.n === 2, 'D1 audit batch');
        return Response.json({ atomicUpsert: true, tenant: true, predicate: true });
      }
      if (path === '/cedar') {
        for (const sql of policySqliteSchema) await env.DB.exec(sql);
        const store = new D1PolicyStore(env.DB),
          engine = createCedarEngine({ vocabulary, binding: cloudflareCedar(), store });
        await engine.save(
          policyScope,
          { policies: { allow: 'permit(principal, action, resource);' } },
          null,
          audit(),
        );
        const check = {
          scope: policyScope,
          principal: { type: 'User', id: 'u' } as const,
          action: 'read' as const,
          resource: { type: 'Doc', id: '1' } as const,
          context: {},
          entities: [
            entity(vocabulary, 'User', 'u', { attrs: {} }),
            entity(vocabulary, 'Doc', '1', { attrs: { rank: 1 } }),
          ],
        };
        assert((await engine.check(check)).allowed, 'Cedar WASM allow');
        await engine.save(
          policyScope,
          { policies: { deny: 'forbid(principal, action, resource);' } },
          1,
          audit(),
        );
        assert(!(await engine.check(check)).allowed, 'Cedar revocation');
        engine.dispose();
        return Response.json({ wasm: true, revocation: true });
      }
      if (path === '/crypto') {
        const ring = await LocalKeyRing.fromRaw('one', {
            one: crypto.getRandomValues(new Uint8Array(32)),
          }),
          service = new CryptoService(ring),
          cipher = service.forContext({
            namespace: 'app:test',
            tenantId: 'a',
            purpose: 'r2',
            caller: { object: 'file' },
          });
        const encrypted = await cipher.encryptText('private');
        assert((await cipher.decryptText(encrypted)) === 'private', 'Web Crypto roundtrip');
        const data = new TextEncoder().encode('streamed private data');
        await encryptToR2(
          env.BUCKET,
          'file',
          new ReadableStream({
            start(c) {
              c.enqueue(data);
              c.close();
            },
          }),
          cipher,
        );
        const decrypted = await decryptFromR2(env.BUCKET, 'file', cipher);
        assert(
          decrypted && (await new Response(decrypted).text()) === 'streamed private data',
          'R2 streaming',
        );
        return Response.json({ webCrypto: true, r2: true });
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      return Response.json(
        { error: String(error), stack: error instanceof Error ? error.stack : undefined },
        { status: 500 },
      );
    }
  },
};
