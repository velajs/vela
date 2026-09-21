import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { describe, it, expect } from 'vitest';
import {
  initializeCedar,
  createCedarEngine,
  defineVocabulary,
  t,
  entity,
  MemoryPolicyStore,
  type PolicyBundle,
} from '../index';
import { compileCedarSql, cedarCrudPlan, type CedarSqlMapping } from '../plan';
const binding = initializeCedar(
  await WebAssembly.compile(
    await readFile(
      new URL('cedar_wasm_bg.wasm', import.meta.resolve('@cedar-policy/cedar-wasm/web')),
    ),
  ),
);
const vocabulary = defineVocabulary({
  namespace: 'Demo',
  entities: {
    User: {},
    Group: {},
    Doc: { memberOf: ['Group'], attrs: { label: t.optional(t.string()), rank: t.long() } },
  },
  actions: { read: { principal: ['User'], resource: ['Doc'] } },
});
const scope = { application: 'app', environment: 'test', tenantId: 'a' },
  principal = { type: 'User', id: 'alice' } as const;
const audit = () => ({
  id: crypto.randomUUID(),
  actor: 'administrator',
  reason: 'Policy test',
  at: Date.now(),
});
const request = { scope, principal, action: 'read', context: {} } as const;
const mapping: CedarSqlMapping = {
  resourceType: 'Doc',
  id: 'id',
  attributes: { label: { field: 'label', kind: 'string' }, rank: { field: 'rank', kind: 'long' } },
};
const rows = [
  { id: 'a', label: 'Alpha%_', rank: 1 },
  { id: 'b', label: 'AlphaXY', rank: 1 },
  { id: 'c', label: 'Alpha%_', rank: 11 },
  { id: 'd', label: null, rank: 1 },
  { id: 'e', label: 'alpha%_', rank: 1 },
];
const rowEntities = (row: (typeof rows)[number]) => [
  entity(vocabulary, 'User', 'alice', { attrs: {} }),
  entity(vocabulary, 'Doc', row.id, {
    attrs: { rank: row.rank, ...(row.label === null ? {} : { label: row.label }) },
  }),
];
async function fixture(bundle: PolicyBundle) {
  const store = new MemoryPolicyStore(),
    engine = createCedarEngine({ vocabulary, binding, store, maxCompiledScopes: 2 });
  await engine.save(scope, bundle, null, audit());
  return { engine, store };
}
describe('Cedar web runtime and exact query plans', () => {
  it('agrees with SQLite and PostgreSQL for permits, forbids, optional fields and literal wildcards', async () => {
    const { engine } = await fixture({
      policies: {
        permit:
          'permit(principal, action == Demo::Action::"read", resource) when { resource has label && resource.label like "A*%_" };',
        forbid: 'forbid(principal, action, resource) when { resource.rank > 10 };',
      },
    });
    const plan = await engine.plan({
      ...request,
      resourceType: 'Doc',
      entities: [entity(vocabulary, 'User', 'alice', { attrs: {} })],
    });
    const allowed: string[] = [];
    for (const row of rows)
      if (
        (
          await engine.check({
            ...request,
            resource: { type: 'Doc', id: row.id },
            entities: rowEntities(row),
          })
        ).allowed
      )
        allowed.push(row.id);
    expect(allowed).toEqual(['a']);
    expect(cedarCrudPlan(plan, mapping).kind).toBe('conditional');
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('CREATE TABLE docs(id TEXT PRIMARY KEY,label TEXT,rank INTEGER NOT NULL)');
    for (const row of rows)
      sqlite.prepare('INSERT INTO docs VALUES(?,?,?)').run(row.id, row.label, row.rank);
    const compiled = compileCedarSql(plan.condition, mapping, 'sqlite');
    expect(
      sqlite
        .prepare(`SELECT id FROM docs WHERE ${compiled.sql} ORDER BY id`)
        .all(...compiled.params.map((v) => (typeof v === 'boolean' ? Number(v) : v)))
        .map((r) => r.id),
    ).toEqual(allowed);
    sqlite.close();
    const pg = new PGlite();
    try {
      await pg.exec('CREATE TABLE docs(id text PRIMARY KEY,label text,rank integer NOT NULL)');
      for (const row of rows)
        await pg.query('INSERT INTO docs VALUES($1,$2,$3)', [row.id, row.label, row.rank]);
      const compiled = compileCedarSql(plan.condition, mapping, 'pg');
      expect(
        (
          await pg.query<{ id: string }>(
            `SELECT id FROM docs WHERE ${compiled.sql} ORDER BY id`,
            compiled.params,
          )
        ).rows.map((r) => r.id),
      ).toEqual(allowed);
    } finally {
      await pg.close();
      engine.dispose();
    }
  });
  it('observes policy revisions on every admission and isolates tenants and environments', async () => {
    const { engine, store } = await fixture({
      policies: { allow: 'permit(principal, action, resource);' },
    });
    const check = {
      ...request,
      resource: { type: 'Doc', id: 'a' } as const,
      entities: rowEntities(rows[0]!),
    };
    expect((await engine.check(check)).allowed).toBe(true);
    await engine.save(
      scope,
      { policies: { deny: 'forbid(principal, action, resource);' } },
      1,
      audit(),
    );
    expect((await engine.check(check)).allowed).toBe(false);
    expect((await engine.check({ ...check, scope: { ...scope, tenantId: 'b' } })).allowed).toBe(
      false,
    );
    expect(
      (await engine.check({ ...check, scope: { ...scope, environment: 'prod' } })).allowed,
    ).toBe(false);
    expect(store.audit()).toHaveLength(2);
    engine.dispose();
  });
  it('supports template links and hierarchy plans and rejects unmapped hierarchy', async () => {
    const { engine } = await fixture({
      policies: {},
      templates: {
        owner:
          'permit(principal == ?principal, action == Demo::Action::"read", resource in Demo::Group::"team");',
      },
      links: [{ id: 'alice', templateId: 'owner', principal }],
    });
    const entities = [
      entity(vocabulary, 'User', 'alice', { attrs: {} }),
      entity(vocabulary, 'Group', 'team', { attrs: {} }),
    ];
    const plan = await engine.plan({ ...request, resourceType: 'Doc', entities });
    expect(() => compileCedarSql(plan.condition, mapping, 'sqlite')).toThrow('hierarchy');
    const hierarchical = { ...mapping, hierarchy: () => ['a'] };
    const compiled = compileCedarSql(plan.condition, hierarchical, 'sqlite');
    expect(compiled.params).toContain('a');
    const allowed: string[] = [];
    for (const id of ['a', 'b']) {
      const decision = await engine.check({
        ...request,
        resource: { type: 'Doc', id },
        entities: [
          ...entities,
          entity(vocabulary, 'Doc', id, {
            attrs: { rank: 1 },
            parents: id === 'a' ? [{ type: 'Group', id: 'team' }] : [],
          }),
        ],
      });
      if (decision.allowed) allowed.push(id);
    }
    expect(allowed).toEqual(['a']);
    const sqlite = new DatabaseSync(':memory:');
    const pg = new PGlite();
    try {
      sqlite.exec("CREATE TABLE docs(id TEXT PRIMARY KEY); INSERT INTO docs VALUES('a'),('b')");
      expect(
        sqlite
          .prepare(`SELECT id FROM docs WHERE ${compiled.sql} ORDER BY id`)
          .all(
            ...compiled.params.map((value) => (typeof value === 'boolean' ? Number(value) : value)),
          )
          .map((row) => row.id),
      ).toEqual(allowed);
      await pg.exec("CREATE TABLE docs(id TEXT PRIMARY KEY); INSERT INTO docs VALUES('a'),('b')");
      const pgPlan = compileCedarSql(plan.condition, hierarchical, 'pg');
      expect(
        (
          await pg.query<{ id: string }>(
            `SELECT id FROM docs WHERE ${pgPlan.sql} ORDER BY id`,
            pgPlan.params,
          )
        ).rows.map((row) => row.id),
      ).toEqual(allowed);
    } finally {
      sqlite.close();
      await pg.close();
      engine.dispose();
    }
  });
  it('fails closed on unsupported expressions, malformed policies and unavailable stores', async () => {
    const { engine } = await fixture({
      policies: { allow: 'permit(principal, action, resource) when { resource.rank + 1 > 3 };' },
    });
    await expect(engine.plan({ ...request, resourceType: 'Doc', entities: [] })).rejects.toThrow();
    expect(() => engine.validate({ policies: { bad: 'not cedar' } })).toThrow();
    const broken = createCedarEngine({
      vocabulary,
      binding,
      store: {
        get: async () => {
          throw new Error('authority offline');
        },
        put: async () => false,
      },
    });
    await expect(
      broken.check({
        ...request,
        resource: { type: 'Doc', id: 'a' },
        entities: rowEntities(rows[0]!),
      }),
    ).rejects.toThrow('offline');
    engine.dispose();
    broken.dispose();
  });
});

it('differentially preserves nested negation, missing values and escaped pattern literals', async () => {
  const samples = [
    ...rows,
    { id: 'f', label: 'A?[special]', rank: 2 },
    { id: 'g', label: 'Alpha%_\n', rank: 3 },
  ];
  const cases = [
    '!(resource has label && resource.label == "Alpha%_")',
    '(resource has label && resource.label != "AlphaXY") || resource.rank >= 10',
    'resource has label && resource.label like "A?[*"',
    'resource has label && resource.label like "Alpha%_"',
  ];
  const pg = new PGlite(),
    sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec('CREATE TABLE docs(id TEXT PRIMARY KEY,label TEXT,rank INTEGER NOT NULL)');
    await pg.exec('CREATE TABLE docs(id text PRIMARY KEY,label text,rank integer NOT NULL)');
    for (const row of samples) {
      sqlite.prepare('INSERT INTO docs VALUES(?,?,?)').run(row.id, row.label, row.rank);
      await pg.query('INSERT INTO docs VALUES($1,$2,$3)', [row.id, row.label, row.rank]);
    }
    for (const condition of cases) {
      const { engine } = await fixture({
        policies: {
          permit: `permit(principal, action, resource) when { ${condition} };`,
          forbid: 'forbid(principal, action, resource) when { resource.rank > 10 };',
        },
      });
      try {
        const allowed = [];
        for (const row of samples)
          if (
            (
              await engine.check({
                ...request,
                resource: { type: 'Doc', id: row.id },
                entities: rowEntities(row),
              })
            ).allowed
          )
            allowed.push(row.id);
        const plan = await engine.plan({
          ...request,
          resourceType: 'Doc',
          entities: [entity(vocabulary, 'User', 'alice', { attrs: {} })],
        });
        const sq = compileCedarSql(plan.condition, mapping, 'sqlite'),
          pq = compileCedarSql(plan.condition, mapping, 'pg');
        expect(
          sqlite
            .prepare(`SELECT id FROM docs WHERE ${sq.sql} ORDER BY id`)
            .all(...sq.params.map((v) => (typeof v === 'boolean' ? Number(v) : v)))
            .map((r) => r.id),
        ).toEqual(allowed);
        expect(
          (
            await pg.query<{ id: string }>(
              `SELECT id FROM docs WHERE ${pq.sql} ORDER BY id`,
              pq.params,
            )
          ).rows.map((r) => r.id),
        ).toEqual(allowed);
      } finally {
        engine.dispose();
      }
    }
  } finally {
    sqlite.close();
    await pg.close();
  }
});
