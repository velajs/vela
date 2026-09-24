import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import {
  applyCloudflareSync,
  constantCase,
  kebabCase,
  planCloudflareSync,
  type CloudflareFacts,
} from './cf-sync.js';
import type { EntrypointRow } from './introspect.js';
import { parseWranglerText, type WranglerConfig } from './project/wrangler.js';

function wrangler(text: string, path = '/project/wrangler.jsonc'): WranglerConfig {
  const root = parseWranglerText(text, path);
  if (typeof root !== 'object' || root === null || Array.isArray(root)) throw new Error('object');
  return { path, text, format: 'jsonc', root: { ...root } };
}

const row = (kind: string, target: string, meta: unknown): EntrypointRow => ({
  kind,
  target,
  meta: JSON.stringify(meta),
});

const APP: CloudflareFacts = {
  entrypoints: [
    row('schedule:cron', 'Cleanup#run', {
      expression: '0 3 * * *',
      methodName: 'run',
      dialect: 'cloudflare',
    }),
    row('queue', 'EmailProcessor', { queueName: 'emails' }),
    row('cf:queue:module', 'QueueTransportEntrypoints#consume', { consumers: [] }),
    row('queue:registration', 'InjectionToken(vela:queue:client:emails)', {
      name: 'emails',
      binding: 'EMAILS',
      consumers: [],
    }),
    row('cf:queue', 'AuditConsumer#handle', { queueName: 'audit-log' }),
    row('websocket', 'ChatGateway', { options: { binding: 'CHAT_ROOM', path: '/chat' } }),
  ],
  exports: { durableObjects: ['ChatRoom'], workflows: ['SignupFlow'], entrypoints: [] },
};

const TEXT = `{
  // The Worker.
  "name": "shop",
  "main": "src/worker.ts",
  "compatibility_date": "2026-09-20",
  "triggers": { "crons": ["0 4 * * *"] }, // a stale trigger
}
`;

describe('vela cf sync plan', () => {
  it('derives crons, queues, Durable Objects, migrations and Workflows from the app', () => {
    const plan = planCloudflareSync(wrangler(TEXT), undefined, APP);
    expect(plan.changes.map(({ path, value, op }) => ({ path, value, op }))).toEqual([
      { path: ['triggers', 'crons'], value: '0 3 * * *', op: 'append' },
      { path: ['triggers', 'crons', 0], value: '0 4 * * *', op: 'remove' },
      {
        path: ['queues', 'producers'],
        value: { binding: 'EMAILS', queue: 'shop-emails' },
        op: 'append',
      },
      { path: ['queues', 'consumers'], value: { queue: 'shop-emails' }, op: 'append' },
      { path: ['queues', 'consumers'], value: { queue: 'audit-log' }, op: 'append' },
      {
        path: ['durable_objects', 'bindings'],
        value: { name: 'CHAT_ROOM', class_name: 'ChatRoom' },
        op: 'append',
      },
      {
        path: ['migrations'],
        value: { tag: 'v1', new_sqlite_classes: ['ChatRoom'] },
        op: 'append',
      },
      {
        path: ['workflows'],
        value: { name: 'shop-signup-flow', binding: 'SIGNUP_FLOW', class_name: 'SignupFlow' },
        op: 'append',
      },
    ]);
    expect(plan.changes.slice(0, 2).map((change) => change.summary)).toEqual([
      '+ triggers.crons: "0 3 * * *"',
      '- triggers.crons: "0 4 * * *" (no @Cron job declares it)',
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it('reports nothing for a configuration that matches the app', () => {
    const synced = applyCloudflareSync(
      TEXT,
      planCloudflareSync(wrangler(TEXT), undefined, APP).changes,
    );
    expect(planCloudflareSync(wrangler(synced), undefined, APP)).toEqual({
      changes: [],
      warnings: [],
    });
  });

  it('edits JSONC in place, keeping comments and appending to existing arrays', () => {
    const text = `{
  // Keep me.
  "name": "shop",
  "main": "src/worker.ts",
  "queues": {
    // Producers first.
    "producers": [{ "binding": "OTHER", "queue": "other" }],
  },
  "migrations": [{ "tag": "v4", "new_sqlite_classes": ["Legacy"] }],
}
`;
    const plan = planCloudflareSync(wrangler(text), undefined, {
      entrypoints: APP.entrypoints.filter((entry) => entry.kind !== 'websocket'),
      exports: { durableObjects: ['ChatRoom', 'Legacy'], workflows: [], entrypoints: [] },
    });
    const written = applyCloudflareSync(text, plan.changes);
    expect(written).toContain('// Keep me.');
    expect(written).toContain('// Producers first.');
    expect(parse(written, [], { allowTrailingComma: true })).toMatchObject({
      queues: {
        producers: [
          { binding: 'OTHER', queue: 'other' },
          { binding: 'EMAILS', queue: 'shop-emails' },
        ],
      },
      durable_objects: {
        bindings: [
          { name: 'CHAT_ROOM', class_name: 'ChatRoom' },
          { name: 'LEGACY', class_name: 'Legacy' },
        ],
      },
      migrations: [
        { tag: 'v4', new_sqlite_classes: ['Legacy'] },
        { tag: 'v5', new_sqlite_classes: ['ChatRoom'] },
      ],
    });
    expect(plan.warnings).toEqual([]);
  });

  describe('cron triggers', () => {
    const crons = (...expressions: string[]): CloudflareFacts => ({
      entrypoints: expressions.map((expression) =>
        row('schedule:cron', 'Jobs#run', { expression, methodName: 'run', dialect: 'cloudflare' }),
      ),
      exports: { durableObjects: [], workflows: [], entrypoints: [] },
    });
    const sync = (text: string, facts: CloudflareFacts) =>
      applyCloudflareSync(text, planCloudflareSync(wrangler(text), undefined, facts).changes);
    const written = (text: string) => parse(text, [], { allowTrailingComma: true }).triggers.crons;

    it('adds and removes single triggers, keeping the comments of the array', () => {
      const text = `{
  "name": "shop",
  "main": "src/worker.ts",
  "triggers": {
    "crons": [ // nightly report, owned by ops
      "0 6 * * 1"
    ]
  }
}
`;
      const result = sync(text, crons('0 6 * * *'));
      expect(result).toContain('// nightly report, owned by ops');
      expect(written(result)).toEqual(['0 6 * * *']);
    });

    it('keeps the comments of the triggers it keeps', () => {
      const text = `{
  "name": "shop",
  "main": "src/worker.ts",
  "triggers": { "crons": ["*/5 * * * *" /* legacy */, "0 1 * * *", "0 2 * * *"] }
}
`;
      const middle = sync(text, crons('*/5 * * * *', '0 2 * * *'));
      expect(middle).toContain('"*/5 * * * *" /* legacy */');
      expect(written(middle)).toEqual(['*/5 * * * *', '0 2 * * *']);
      const last = sync(text, crons('*/5 * * * *', '0 1 * * *'));
      expect(last).toContain('/* legacy */');
      expect(written(last)).toEqual(['*/5 * * * *', '0 1 * * *']);
      expect(written(sync(text, crons()))).toEqual([]);
    });

    it('removes a trigger on its own line with its trailing comment', () => {
      const text = `{
  "name": "shop",
  "main": "src/worker.ts",
  "triggers": {
    "crons": [
      // Hourly sync.
      "0 * * * *",
      "0 3 * * *", // retired
      "0 4 * * *" // nightly
    ]
  }
}
`;
      const result = sync(text, crons('0 * * * *', '0 4 * * *'));
      expect(result).toContain(`    "crons": [
      // Hourly sync.
      "0 * * * *",
      "0 4 * * *" // nightly
    ]`);
      const trailing = sync(text, crons('0 * * * *', '0 3 * * *'));
      expect(trailing).toContain(`      "0 * * * *",
      "0 3 * * *" // retired
    ]`);
      expect(written(trailing)).toEqual(['0 * * * *', '0 3 * * *']);
    });

    it('creates the array when the file declares none', () => {
      const text = `{\n  "name": "shop",\n  "main": "src/worker.ts"\n}\n`;
      expect(written(sync(text, crons('0 3 * * *', '0 4 * * *')))).toEqual([
        '0 3 * * *',
        '0 4 * * *',
      ]);
    });
  });

  it('writes non-inherited keys under the named environment', () => {
    const text = `{
  "name": "shop",
  "main": "src/worker.ts",
  "triggers": { "crons": ["0 3 * * *"] },
  "env": { "staging": {} },
}
`;
    const plan = planCloudflareSync(wrangler(text), 'staging', APP);
    const paths = plan.changes.map((change) => change.path.join('.'));
    // Triggers are inherited from the top level and already match.
    expect(paths).not.toContain('triggers.crons');
    expect(paths).toContain('env.staging.queues.producers');
    expect(paths).toContain('env.staging.durable_objects.bindings');
    expect(paths).toContain('migrations');
    expect(
      plan.changes.find((change) => change.path.join('.') === 'env.staging.queues.producers')
        ?.value,
    ).toEqual({
      binding: 'EMAILS',
      queue: 'shop-staging-emails',
    });
  });

  it('warns about what it cannot resolve instead of guessing', () => {
    const text = `{
  "name": "shop",
  "main": "src/worker.ts",
  "durable_objects": { "bindings": [{ "name": "GONE", "class_name": "Removed" }] },
  "workflows": [{ "name": "old", "binding": "OLD", "class_name": "OldFlow" }],
}
`;
    const plan = planCloudflareSync(wrangler(text), undefined, {
      entrypoints: [
        row('schedule:cron', 'NodeJob#run', {
          expression: '0 3 * * *',
          methodName: 'run',
          dialect: 'unix',
        }),
        row('queue', 'Orphan', { queueName: 'orphans' }),
        row('websocket', 'Lobby', { binding: 'LOBBY' }),
      ],
      exports: { durableObjects: [], workflows: [], entrypoints: [] },
    });
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      'NodeJob#run declares the unix dialect, which Workers cron triggers do not run; it gets no trigger.',
      '@Processor("orphans") has no QueueModule.registerQueue({ name: "orphans" }), so no consumer is added for it.',
      'A WebSocket gateway uses the Durable Object binding "LOBBY", which no exported class serves: export a VelaWebSocketDurableObject class from the Worker entry.',
      'The Durable Object binding "GONE" names class "Removed", which the Worker entry does not export.',
      'The Workflow "old" names class "OldFlow", which the Worker entry does not export.',
    ]);
  });

  it('names bindings and Workflows after their classes', () => {
    expect(constantCase('SignupFlow')).toBe('SIGNUP_FLOW');
    expect(constantCase('ChatRoom2')).toBe('CHAT_ROOM2');
    expect(kebabCase('SignupFlow')).toBe('signup-flow');
  });
});
