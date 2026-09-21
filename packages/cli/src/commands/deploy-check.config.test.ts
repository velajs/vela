import { describe, expect, it } from 'vitest';
import { parseDeploymentConfig, selectDeploymentTarget } from './deploy-check.config.js';

const config = () => ({
  name: 'api',
  main: 'dist/worker.js',
  compatibility_date: '2026-09-20',
  env: { staging: {} },
});

describe('deployment configuration', () => {
  it('parses JSONC comments/trailing commas without damaging URLs', () => {
    expect(
      parseDeploymentConfig('{ // comment\n"url":"https://host/path//x",}', 'wrangler.jsonc'),
    ).toEqual({ url: 'https://host/path//x' });
  });

  it('accepts TOML without evaluating code', () => {
    const raw = parseDeploymentConfig(
      'name="api"\nmain="src/worker.ts"\ncompatibility_date="2026-09-20"\n[env.staging]\nname="stage"',
      'wrangler.toml',
    );
    expect(selectDeploymentTarget(raw, 'staging').worker).toBe('stage');
  });

  it.each([
    ['{"x": secret-value}', 'wrangler.jsonc'],
    ['{"x":1,}', 'wrangler.json'],
    ['x = secret-value', 'wrangler.toml'],
    ['export default {}', 'wrangler.ts'],
  ])('rejects invalid formats without echoing configuration contents', (source, file) => {
    expect(() => parseDeploymentConfig(source, file)).toThrow();
    try {
      parseDeploymentConfig(source, file);
    } catch (error) {
      expect(String(error)).not.toContain('secret-value');
    }
  });

  it.each(['', ' staging', 'staging ', '--prod', 'prod\n', '../prod', 'STAGING', 'toString'])(
    'rejects a missing/malformed/unconfigured target %j',
    (environment) => {
      expect(() => selectDeploymentTarget(config(), environment)).toThrow();
    },
  );

  it('never falls back to top-level when the requested environment is missing', () => {
    expect(() => selectDeploymentTarget({ ...config(), env: {} }, 'staging')).toThrow(
      'not declared',
    );
  });

  it('inherits source/date/trigger settings and derives the same worker name as Wrangler', () => {
    const plan = selectDeploymentTarget(
      { ...config(), triggers: { crons: ['0 * * * *'] } },
      'staging',
    );
    expect(plan).toMatchObject({
      worker: 'api-staging',
      main: 'dist/worker.js',
      compatibilityDate: '2026-09-20',
      crons: ['0 * * * *'],
    });
  });

  it('replaces inherited triggers with an explicit empty list', () => {
    expect(
      selectDeploymentTarget(
        {
          ...config(),
          triggers: { crons: ['0 * * * *'] },
          env: { staging: { triggers: { crons: [] } } },
        },
        'staging',
      ).crons,
    ).toEqual([]);
  });

  it('does not inherit any resource bindings or vars', () => {
    const plan = selectDeploymentTarget(
      {
        ...config(),
        vars: { SECRET: 'redact-me' },
        kv_namespaces: [{ binding: 'CACHE', id: 'prod-id' }],
        durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
        queues: { consumers: [{ queue: 'prod' }] },
      },
      'staging',
    );
    expect(plan.bindings).toEqual([]);
    expect(plan.queueConsumers).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain('redact-me');
  });

  it('permits auto-provisioned IDs and multiple distinct D1 bindings', () => {
    const raw = {
      ...config(),
      env: {
        staging: {
          d1_databases: [{ binding: 'ACCOUNTS' }, { binding: 'AUDIT' }],
          kv_namespaces: [{ binding: 'CACHE' }],
          r2_buckets: [{ binding: 'FILES' }],
        },
      },
    };
    expect(selectDeploymentTarget(raw, 'staging').bindings.map((b) => b.name)).toEqual([
      'CACHE',
      'ACCOUNTS',
      'AUDIT',
      'FILES',
    ]);
  });

  it('rejects binding collisions across different resource kinds and vars', () => {
    expect(() =>
      selectDeploymentTarget(
        { ...config(), env: { staging: { vars: { DB: 'x' }, d1_databases: [{ binding: 'DB' }] } } },
        'staging',
      ),
    ).toThrow('Duplicate Worker binding');
  });

  it.each([
    { name: 'bad_name' },
    { name: '' },
    { compatibility_date: '2026-02-30' },
    { triggers: {} },
    { triggers: { crons: '0 * * * *' } },
    { kv_namespaces: {} },
    { durable_objects: { bindings: [{ name: 'ROOM' }] } },
    { queues: { consumers: [{ queue: 1 }] } },
    { vars: 'secret' },
    { main: null },
    { build: { command: 1 } },
  ])('rejects malformed selected configuration %j', (selected) => {
    expect(() =>
      selectDeploymentTarget({ ...config(), env: { staging: selected } }, 'staging'),
    ).toThrow('Invalid Wrangler field');
  });

  it('allows an assets-only Worker with a real configured directory', () => {
    const raw = {
      name: 'assets',
      compatibility_date: '2026-09-20',
      assets: { directory: './public' },
      env: { staging: {} },
    };
    expect(selectDeploymentTarget(raw, 'staging').main).toBeNull();
  });
});
