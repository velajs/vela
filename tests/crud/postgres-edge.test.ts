import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text, integer, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineResource, defineModel } from '@velajs/crud';
import { drizzleAdapter } from '@velajs/crud-drizzle';
import {
  PostgresTenantRegistryStore,
  tenantPostgresSchema,
  tenantRlsStatements,
  withTenantRls,
} from '../../packages/tenant/src/postgres/index';
import { TenantRegistry, TenantService } from '../../packages/tenant/src/index';
import {
  PostgresPolicyStore,
  policyPostgresSchema,
} from '../../packages/authz-cedar/src/postgres/index';
const connectionString = process.env.VELA_POSTGRES_URL;
const docs = pgTable(
  'edge_documents',
  {
    tenantId: text('tenant_id').notNull(),
    id: text('id').notNull(),
    slug: text('slug').notNull(),
    rank: integer('rank').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    uniqueIndex('edge_documents_slug').on(t.slug),
  ],
);
const model = defineModel({
  name: 'doc',
  tableName: 'edge_documents',
  schema: z.object({ tenantId: z.string(), id: z.string(), slug: z.string(), rank: z.number() }),
  primaryKeys: ['tenantId', 'id'],
  id: 'client',
  multiTenant: true,
  timestamps: false,
});
const principal = { issuer: 'test', subject: 'admin', principalType: 'user' } as const;
const policyScope = { application: 'app', environment: 'integration', tenantId: 'a' };
const audit = () => ({
  id: crypto.randomUUID(),
  actor: 'admin',
  reason: 'Integration test',
  at: Date.now(),
});

describe.skipIf(!connectionString)('PostgreSQL authority and atomic boundaries', () => {
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const testSchema = `vela_edge_${suffix}`,
    role = `vela_edge_role_${suffix}`;
  const pool = new Pool({ connectionString, max: 8, options: `-c search_path=${testSchema}` });
  const client = {
    query: async (sql: string, values: readonly unknown[]) => pool.query(sql, [...values]),
  };
  const store = new PostgresTenantRegistryStore(client),
    policies = new PostgresPolicyStore(client);
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${testSchema}`);
    for (const sql of [...tenantPostgresSchema, ...policyPostgresSchema]) await pool.query(sql);
    await pool.query(
      'CREATE TABLE edge_documents(tenant_id text NOT NULL,id text NOT NULL,slug text NOT NULL UNIQUE,rank integer NOT NULL,PRIMARY KEY(tenant_id,id))',
    );
  });
  afterAll(async () => {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`);
      await pool.query(`DROP ROLE IF EXISTS ${role}`);
    } finally {
      await pool.end();
    }
  });
  it('commits one concurrent tenant revision and its audit, observes suspension, and rolls back failed audit', async () => {
    const registry = new TenantRegistry({ store, authorize: () => true });
    const row = { id: 'a', name: 'A', status: 'active' as const, settings: {} };
    await registry.save(row, null, principal, 'Create');
    const outcomes = await Promise.allSettled([
      registry.save({ ...row, name: 'one' }, 1, principal, 'Edit'),
      registry.save({ ...row, name: 'two' }, 1, principal, 'Edit'),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await pool.query('SELECT * FROM vela_tenant_audit')).rowCount).toBe(2);
    const duplicate = (await pool.query('SELECT id FROM vela_tenant_audit LIMIT 1')).rows[0].id;
    await expect(
      store.put({ ...row, revision: 3 }, 2, {
        id: duplicate,
        tenantId: 'a',
        action: 'update',
        principal,
        reason: 'Duplicate audit',
        at: Date.now(),
      }),
    ).rejects.toThrow();
    expect((await store.get('a'))?.revision).toBe(2);
    const service = new TenantService({ lookup: store, authorize: () => true });
    await service.run({ tenantId: 'a', principal }, async (scope) => {
      await registry.save({ ...row, status: 'suspended' }, 2, principal, 'Suspend');
      expect(scope.requireTenantId()).toBe('a');
      await expect(service.admit({ tenantId: 'a', principal })).rejects.toThrow();
    });
  });
  it('persists policy revisions with atomic audit and isolates environments', async () => {
    const bundle = { policies: { allow: 'permit(principal, action, resource);' } };
    expect(await policies.put(policyScope, bundle, null, audit())).toBe(true);
    expect(
      await Promise.all([
        policies.put(policyScope, { policies: {} }, 1, audit()),
        policies.put(policyScope, bundle, 1, audit()),
      ]),
    ).toContain(false);
    expect((await policies.get(policyScope))?.revision).toBe(2);
    expect(await policies.get({ ...policyScope, environment: 'other' })).toBeNull();
    expect((await pool.query('SELECT * FROM vela_cedar_audit')).rowCount).toBe(2);
  });
  it('uses complete IDs, transaction rollback, atomic scoped upserts and committed-delivery errors', async () => {
    const adapter = drizzleAdapter({
      db: drizzle(pool),
      table: docs,
      dialect: 'pg',
      atomicUpsert: true,
      primaryKeys: ['tenantId', 'id'],
    });
    const errors: unknown[] = [];
    const resource = defineResource('documents', {
      model,
      adapter,
      upsert: { keys: ['slug'] },
      authorization: () => ({
        kind: 'conditional',
        predicate: { op: 'lt', field: 'rank', value: 10 },
      }),
      afterCommit: async () => {
        throw Error('delivery');
      },
      onAfterCommitError: (error) => {
        errors.push(error);
      },
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        resource.execute('upsert', {
          vars: { tenantId: 'a' },
          body: { tenantId: 'a', id: `id${i}`, slug: 'same', rank: i },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(7);
    expect(errors).toHaveLength(8);
    await expect(
      resource.execute('upsert', {
        vars: { tenantId: 'b' },
        body: { id: 'id-b', tenantId: 'b', slug: 'same', rank: 1 },
      }),
    ).rejects.toThrow('scope');
    expect((await pool.query('SELECT * FROM edge_documents')).rowCount).toBe(1);
    const stored = (await pool.query('SELECT id FROM edge_documents')).rows[0].id;
    expect(
      (
        await resource.execute('read', {
          vars: { tenantId: 'a' },
          id: { tenantId: 'a', id: stored },
        })
      ).status,
    ).toBe(200);
    await expect(
      adapter.runtime.transaction(async (scope) => {
        await adapter.runtime.create(
          { tenantId: 'a', id: 'rollback', slug: 'rollback', rank: 1 },
          scope,
        );
        throw Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect((await pool.query("SELECT * FROM edge_documents WHERE id='rollback'")).rowCount).toBe(0);
  });
  it('forces RLS for a non-superuser owner and resets transaction-local tenant settings', async () => {
    await pool.query('CREATE TABLE edge_rls(id text PRIMARY KEY,tenant_id text NOT NULL)');
    await pool.query("INSERT INTO edge_rls VALUES('a','a'),('b','b')");
    await pool.query(`CREATE ROLE ${role}`);
    await pool.query(`GRANT USAGE ON SCHEMA ${testSchema} TO ${role}`);
    await pool.query(`ALTER TABLE edge_rls OWNER TO ${role}`);
    for (const sql of tenantRlsStatements('edge_rls')) await pool.query(sql);
    const executor = {
      transaction: async <T>(work: (tx: typeof client) => Promise<T>) => {
        const connection = await pool.connect();
        try {
          await connection.query('BEGIN');
          await connection.query(`SET LOCAL ROLE ${role}`);
          const result = await work({
            query: async (sql, values) => connection.query(sql, [...values]),
          });
          await connection.query('COMMIT');
          return result;
        } catch (error) {
          await connection.query('ROLLBACK');
          throw error;
        } finally {
          connection.release();
        }
      },
    };
    expect(
      (
        await withTenantRls(executor, { requireTenantId: () => 'a' }, (tx) =>
          tx.query('SELECT id FROM edge_rls', []),
        )
      ).rows,
    ).toEqual([{ id: 'a' }]);
    await expect(
      withTenantRls(executor, { requireTenantId: () => 'a' }, (tx) =>
        tx.query("INSERT INTO edge_rls VALUES('x','b')", []),
      ),
    ).rejects.toThrow('row-level security');
    expect(
      (await executor.transaction((tx) => tx.query('SELECT id FROM edge_rls', []))).rows,
    ).toEqual([]);
  });
});
