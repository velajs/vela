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

/** The row `vela entrypoint list` prints for a kind without entrypoints. */
const placeholder = (kind: string): EntrypointRow => ({
  kind,
  target: '(no entrypoints)',
  meta: '',
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
  exports: {
    durableObjects: ['ChatRoom'],
    workflows: ['SignupFlow'],
    entrypoints: [],
    velaDurableObjects: [],
    unexportedDurableObjects: [],
  },
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
  it('keeps cron triggers no @Cron job declares unless pruning, and reports them', () => {
    // A Worker entry with its own scheduled handler may need them.
    const kept = planCloudflareSync(wrangler(TEXT), undefined, APP);
    expect(kept.changes.filter((change) => change.op === 'remove')).toEqual([]);
    expect(kept.warnings).toEqual([
      'triggers.crons: "0 4 * * *" is not declared by any @Cron job; kept (pass --prune to remove it).',
    ]);
    const pruned = planCloudflareSync(wrangler(TEXT), undefined, APP, { prune: true });
    expect(pruned.changes.filter((change) => change.op === 'remove')).toMatchObject([
      { path: ['triggers', 'crons', 0], value: '0 4 * * *', op: 'remove' },
    ]);
    expect(pruned.warnings).toEqual([]);
    // Once in sync, a kept trigger is reported again, but nothing changes.
    const synced = applyCloudflareSync(TEXT, kept.changes);
    expect(planCloudflareSync(wrangler(synced), undefined, APP)).toEqual({
      changes: [],
      warnings: kept.warnings,
    });
  });

  it('derives crons, queues, Durable Objects, migrations and Workflows from the app', () => {
    const plan = planCloudflareSync(wrangler(TEXT), undefined, APP, { prune: true });
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
      planCloudflareSync(wrangler(TEXT), undefined, APP, { prune: true }).changes,
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
      exports: {
        durableObjects: ['ChatRoom', 'Legacy'],
        workflows: [],
        entrypoints: [],
        velaDurableObjects: [],
        unexportedDurableObjects: [],
      },
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
      exports: {
        durableObjects: [],
        workflows: [],
        entrypoints: [],
        velaDurableObjects: [],
        unexportedDurableObjects: [],
      },
    });
    const sync = (text: string, facts: CloudflareFacts) =>
      applyCloudflareSync(
        text,
        planCloudflareSync(wrangler(text), undefined, facts, { prune: true }).changes,
      );
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
      expect(sync(text, crons('0 3 * * *', '0 4 * * *'))).toBe(`{
  "name": "shop",
  "main": "src/worker.ts",
  "triggers": {
    "crons": [
      "0 3 * * *",
      "0 4 * * *"
    ]
  }
}
`);
    });

    it('appends after the line comment of the last trigger, which stays with it', () => {
      const text = `{
  "name": "shop",
  "main": "src/worker.ts",
  "triggers": {
    "crons": [
      "0 3 * * *" // nightly
    ]
  }
}
`;
      expect(sync(text, crons('0 3 * * *', '0 4 * * *'))).toContain(`    "crons": [
      "0 3 * * *", // nightly
      "0 4 * * *"
    ]`);
      const trailingComma = text.replace('"0 3 * * *" // nightly', '"0 3 * * *", // nightly');
      expect(sync(trailingComma, crons('0 3 * * *', '0 4 * * *'))).toContain(`    "crons": [
      "0 3 * * *", // nightly
      "0 4 * * *",
    ]`);
      const inline = text.replace('"0 3 * * *" // nightly', '"0 3 * * *" /* nightly */');
      expect(sync(inline, crons('0 3 * * *', '0 4 * * *'))).toContain(`    "crons": [
      "0 3 * * *", /* nightly */
      "0 4 * * *"
    ]`);
    });

    it('appends after a block comment that runs over several lines', () => {
      const text = `{
  "name": "shop",
  "main": "src/worker.ts",
  "triggers": {
    "crons": [
      "0 3 * * *" /* nightly,
         owned by ops */
    ]
  }
}
`;
      expect(sync(text, crons('0 3 * * *', '0 4 * * *'))).toContain(`    "crons": [
      "0 3 * * *", /* nightly,
         owned by ops */
      "0 4 * * *"
    ]`);
      const trailing = text.replace('"0 3 * * *" /* nightly', '"0 3 * * *", /* nightly');
      expect(sync(trailing, crons('0 3 * * *', '0 4 * * *'))).toContain(`    "crons": [
      "0 3 * * *", /* nightly,
         owned by ops */
      "0 4 * * *",
    ]`);
    });

    it('keeps a one-line Wrangler file on one line', () => {
      const text = `{ "name": "shop", "main": "src/worker.ts", "triggers": { "crons": ["0 3 * * *" /* nightly */] } }\n`;
      expect(sync(text, crons('0 3 * * *', '0 4 * * *'))).toBe(
        `{ "name": "shop", "main": "src/worker.ts", "triggers": { "crons": ["0 3 * * *" /* nightly */, "0 4 * * *"] } }\n`,
      );
      expect(sync(`{ "name": "shop", "main": "src/worker.ts" }\n`, crons('0 3 * * *'))).toBe(
        `{ "name": "shop", "main": "src/worker.ts", "triggers": { "crons": ["0 3 * * *"] } }\n`,
      );
      expect(sync(`{ "name": "shop", "triggers": { "crons": [] } }\n`, crons('0 3 * * *'))).toBe(
        `{ "name": "shop", "triggers": { "crons": ["0 3 * * *"] } }\n`,
      );
    });
  });

  it('lays out an empty container like the lines around it, with their indentation and line ends', () => {
    const tabs =
      '{\r\n\t"name": "shop",\r\n\t"main": "src/worker.ts",\r\n\t"triggers": { "crons": [] },\r\n\t"env": { "staging": {} }\r\n}\r\n';
    const plan = planCloudflareSync(wrangler(tabs), undefined, {
      entrypoints: APP.entrypoints.filter((entry) => entry.kind === 'schedule:cron'),
      exports: {
        durableObjects: [],
        workflows: [],
        entrypoints: [],
        velaDurableObjects: [],
        unexportedDurableObjects: [],
      },
    });
    expect(applyCloudflareSync(tabs, plan.changes)).toBe(
      '{\r\n\t"name": "shop",\r\n\t"main": "src/worker.ts",\r\n\t"triggers": { "crons": ["0 3 * * *"] },\r\n\t"env": { "staging": {} }\r\n}\r\n',
    );
    const staging = planCloudflareSync(wrangler(tabs), 'staging', {
      entrypoints: APP.entrypoints.filter((entry) => entry.kind === 'queue:registration'),
      exports: {
        durableObjects: [],
        workflows: [],
        entrypoints: [],
        velaDurableObjects: [],
        unexportedDurableObjects: [],
      },
    });
    expect(applyCloudflareSync(tabs, staging.changes)).toContain(
      '\t"env": { "staging": { "queues": { "producers": [{ "binding": "EMAILS", "queue": "shop-staging-emails" }] } } }\r\n',
    );
    const own = `{\n  "name": "shop",\n  "main": "src/worker.ts",\n  "workflows": []\n}\n`;
    expect(
      applyCloudflareSync(
        own,
        planCloudflareSync(wrangler(own), undefined, {
          entrypoints: [],
          exports: {
            durableObjects: [],
            workflows: ['SignupFlow'],
            entrypoints: [],
            velaDurableObjects: [],
            unexportedDurableObjects: [],
          },
        }).changes,
      ),
    ).toBe(`{
  "name": "shop",
  "main": "src/worker.ts",
  "workflows": [
    {
      "name": "shop-signup-flow",
      "binding": "SIGNUP_FLOW",
      "class_name": "SignupFlow"
    }
  ]
}
`);
  });

  it('adds new sections after the last one, keeping its comment and trailing comma', () => {
    const plan = planCloudflareSync(
      wrangler(TEXT),
      undefined,
      {
        entrypoints: APP.entrypoints.filter(
          (entry) => entry.kind === 'schedule:cron' || entry.kind.startsWith('queue'),
        ),
        exports: {
          durableObjects: [],
          workflows: [],
          entrypoints: [],
          velaDurableObjects: [],
          unexportedDurableObjects: [],
        },
      },
      { prune: true },
    );
    expect(applyCloudflareSync(TEXT, plan.changes)).toBe(`{
  // The Worker.
  "name": "shop",
  "main": "src/worker.ts",
  "compatibility_date": "2026-09-20",
  "triggers": { "crons": ["0 3 * * *"] }, // a stale trigger
  "queues": {
    "producers": [
      {
        "binding": "EMAILS",
        "queue": "shop-emails"
      }
    ]
  },
}
`);
  });

  it('appends objects to a one-line array on its line', () => {
    const text = `{
  "name": "shop",
  "main": "src/worker.ts",
  "queues": { "producers": [{ "binding": "OTHER", "queue": "other" }] },
}
`;
    const plan = planCloudflareSync(wrangler(text), undefined, {
      entrypoints: APP.entrypoints.filter((entry) => entry.kind === 'queue:registration'),
      exports: {
        durableObjects: [],
        workflows: [],
        entrypoints: [],
        velaDurableObjects: [],
        unexportedDurableObjects: [],
      },
    });
    expect(applyCloudflareSync(text, plan.changes)).toContain(
      `  "queues": { "producers": [{ "binding": "OTHER", "queue": "other" }, { "binding": "EMAILS", "queue": "shop-emails" }] },\n`,
    );
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
      exports: {
        durableObjects: [],
        workflows: [],
        entrypoints: [],
        velaDurableObjects: [],
        unexportedDurableObjects: [],
      },
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

  it('binds the gateway binding to the exported WebSocket Durable Object class', () => {
    const text = `{\n  "name": "shop",\n  "main": "src/worker.ts"\n}\n`;
    const plan = planCloudflareSync(wrangler(text), undefined, {
      entrypoints: [row('websocket', 'Lobby', { binding: 'LOBBY' })],
      exports: {
        durableObjects: ['Counter', 'ChatRoom'],
        workflows: [],
        entrypoints: [],
        velaDurableObjects: [
          { name: 'Counter', kind: 'host', host: 'CounterHost', methods: ['increment'] },
          { name: 'ChatRoom', kind: 'websocket', methods: ['broadcast'] },
        ],
        unexportedDurableObjects: [],
      },
    });
    expect(
      plan.changes
        .filter((change) => change.path.join('.') === 'durable_objects.bindings')
        .map((change) => change.value),
    ).toEqual([
      { name: 'COUNTER', class_name: 'Counter' },
      { name: 'LOBBY', class_name: 'ChatRoom' },
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it('warns about Durable Object classes the app defines but the Worker entry does not export', () => {
    const text = `{\n  "name": "shop",\n  "main": "src/worker.ts"\n}\n`;
    const plan = planCloudflareSync(wrangler(text), undefined, {
      entrypoints: [],
      exports: {
        durableObjects: [],
        workflows: [],
        entrypoints: [],
        velaDurableObjects: [],
        unexportedDurableObjects: ['AuditHost', 'WebSocket'],
      },
    });
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      'The app defines a Durable Object class for AuditHost, which the Worker entry does not export: export it (export class Name extends VelaDurableObject(app, AuditHost) {}) so Wrangler can bind it.',
      'The app defines a Durable Object class for WebSocket, which the Worker entry does not export: export it (export class Name extends VelaWebSocketDurableObject(app) {}) so Wrangler can bind it.',
    ]);
  });

  it('ignores the placeholder rows of kinds without entrypoints', () => {
    const text = `{\n  "name": "shop",\n  "main": "src/worker.ts"\n}\n`;
    const plan = planCloudflareSync(wrangler(text), undefined, {
      entrypoints: [
        'schedule:cron',
        'queue',
        'queue:registration',
        'cf:queue:module',
        'cf:queue',
      ].map(placeholder),
      exports: {
        durableObjects: [],
        workflows: [],
        entrypoints: [],
        velaDurableObjects: [],
        unexportedDurableObjects: [],
      },
    });
    expect(plan).toEqual({ changes: [], warnings: [] });
  });

  it('names bindings and Workflows after their classes', () => {
    expect(constantCase('SignupFlow')).toBe('SIGNUP_FLOW');
    expect(constantCase('ChatRoom2')).toBe('CHAT_ROOM2');
    expect(kebabCase('SignupFlow')).toBe('signup-flow');
  });
});
