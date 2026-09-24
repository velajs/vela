import { applyEdits, findNodeAtLocation, modify, parseTree, type JSONPath } from 'jsonc-parser';
import { cronDialectAmbiguity, parseCronMetadata } from '@velajs/vela/module-kit';
import type { EntrypointRow } from './introspect.js';
import { isRecord } from './project/files.js';
import type { WorkerExports } from './project/worker-entry.js';
import { environmentSection, wranglerWorkerName, type WranglerConfig } from './project/wrangler.js';

/** What the application declares, as `vela cf sync` compares it with Wrangler. */
export interface CloudflareFacts {
  /** `vela entrypoint list --json` rows. */
  readonly entrypoints: readonly EntrypointRow[];
  /** The platform classes the Worker entry exports. */
  readonly exports: WorkerExports;
}

/** One edit of the Wrangler file: set `path`, or append to the array at `path` (`append`). */
export interface SyncChange {
  readonly path: JSONPath;
  readonly value: unknown;
  readonly append: boolean;
  /** One line for people: `+ queues.consumers: { "queue": "jobs" }`. */
  readonly summary: string;
}

export interface SyncPlan {
  readonly changes: readonly SyncChange[];
  /** What the command cannot fix itself; nothing is removed but cron triggers. */
  readonly warnings: readonly string[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function meta(row: EntrypointRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(row.meta);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** `SignupFlow` → `SIGNUP_FLOW`. */
export function constantCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

/** `SignupFlow` → `signup-flow`. */
export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

const show = (value: unknown): string => JSON.stringify(value, null, 1).replace(/\s*\n\s*/g, ' ');

/** A key of the target: inheritable keys live where the environment reads them from. */
function location(
  config: WranglerConfig,
  environment: string | undefined,
  key: string,
  inheritable: boolean,
): { path: JSONPath; value: unknown } {
  const section = environmentSection(config, environment);
  const own = environment === undefined || Object.hasOwn(section, key);
  if (own || !inheritable) {
    return {
      path: environment === undefined ? [key] : ['env', environment, key],
      value: section[key],
    };
  }
  return { path: [key], value: config.root[key] };
}

const label = (path: JSONPath): string => path.join('.');

/**
 * Compare the Wrangler target (the top level, or `environment`) with what the
 * application declares: cron triggers for `@Cron` jobs, queue producers for
 * `QueueModule.registerQueue({ binding })`, consumers for the queues its
 * processors and `@QueueConsumer` handlers read, and Durable Object bindings,
 * migrations and Workflows for the classes the Worker entry exports.
 */
export function planCloudflareSync(
  config: WranglerConfig,
  environment: string | undefined,
  facts: CloudflareFacts,
): SyncPlan {
  const changes: SyncChange[] = [];
  const warnings: string[] = [];
  const worker = wranglerWorkerName(config, environment);
  const rows = (kind: string) => facts.entrypoints.filter((row) => row.kind === kind);

  // Cron triggers: exactly the expressions the @Cron jobs deliver on Workers.
  const crons: string[] = [];
  for (const row of rows('schedule:cron')) {
    let cron;
    try {
      cron = parseCronMetadata(meta(row));
    } catch {
      warnings.push(`${row.target} has unreadable @Cron metadata.`);
      continue;
    }
    if (cron.dialect !== undefined && cron.dialect !== 'cloudflare') {
      warnings.push(
        `${row.target} declares the ${cron.dialect} dialect, which Workers cron triggers do not run; it gets no trigger.`,
      );
      continue;
    }
    if (cronDialectAmbiguity(cron) !== undefined) {
      warnings.push(
        `${row.target} declares no dialect for ${JSON.stringify(cron.expression)}, which fires on ` +
          "different days under Node and Workers; declare { dialect: 'cloudflare' }.",
      );
    }
    if (!crons.includes(cron.expression)) crons.push(cron.expression);
  }
  const triggers = location(config, environment, 'triggers', true);
  const current = strings(isRecord(triggers.value) ? triggers.value.crons : undefined);
  const kept = current.filter((cron) => crons.includes(cron));
  const added = crons.filter((cron) => !current.includes(cron));
  if (added.length > 0 || kept.length !== current.length) {
    const path = [...triggers.path, 'crons'];
    const summary = [
      ...added.map((cron) => `+ ${label(path)}: ${JSON.stringify(cron)}`),
      ...current
        .filter((cron) => !crons.includes(cron))
        .map((cron) => `- ${label(path)}: ${JSON.stringify(cron)} (no @Cron job declares it)`),
    ].join('\n');
    changes.push({ path, value: [...kept, ...added], append: false, summary });
  }

  // Queues: producers for registered bindings, consumers for processed queues.
  const queues = location(config, environment, 'queues', false);
  const queueSection = isRecord(queues.value) ? queues.value : {};
  const producers = new Map<string, string | undefined>();
  for (const row of records(queueSection.producers)) {
    if (typeof row.binding === 'string') {
      producers.set(row.binding, typeof row.queue === 'string' ? row.queue : undefined);
    }
  }
  const consumers = new Set(
    records(queueSection.consumers).flatMap((row) =>
      typeof row.queue === 'string' ? [row.queue] : [],
    ),
  );
  const wantedConsumers: string[] = [];
  const registrations = new Map<string, { binding?: string; consumers: string[] }>();
  for (const row of rows('queue:registration')) {
    const data = meta(row);
    if (typeof data.name !== 'string') continue;
    const existing = registrations.get(data.name);
    registrations.set(data.name, {
      binding: existing?.binding ?? (typeof data.binding === 'string' ? data.binding : undefined),
      consumers: [...new Set([...(existing?.consumers ?? []), ...strings(data.consumers)])],
    });
  }
  for (const [name, registration] of registrations) {
    const { binding } = registration;
    if (binding === undefined || producers.has(binding)) continue;
    const queue = registration.consumers[0] ?? `${worker}-${name}`;
    producers.set(binding, queue);
    changes.push({
      path: [...queues.path, 'producers'],
      value: { binding, queue },
      append: true,
      summary: `+ ${label([...queues.path, 'producers'])}: ${show({ binding, queue })}`,
    });
  }
  const moduleConsumer = rows('cf:queue:module').length > 0;
  for (const row of rows('queue')) {
    const name = meta(row).queueName;
    if (typeof name !== 'string') continue;
    const registration = registrations.get(name);
    if (!registration) {
      warnings.push(
        `@Processor(${JSON.stringify(name)}) has no QueueModule.registerQueue({ name: ` +
          `${JSON.stringify(name)} }), so no consumer is added for it.`,
      );
      continue;
    }
    // Only a driver that consumes natively (cloudflareQueues()) reads Cloudflare queues.
    if (!moduleConsumer) continue;
    const produced =
      registration.binding === undefined ? undefined : producers.get(registration.binding);
    const physical =
      registration.consumers.length > 0 ? registration.consumers : produced ? [produced] : [];
    if (physical.length === 0) {
      warnings.push(
        `Queue ${JSON.stringify(name)} names no physical queue: register it with a binding or ` +
          'QueueModule.registerQueue({ name, consumer }).',
      );
    }
    wantedConsumers.push(...physical);
  }
  for (const row of rows('cf:queue')) {
    const name = meta(row).queueName;
    if (typeof name === 'string') wantedConsumers.push(name);
  }
  for (const queue of new Set(wantedConsumers)) {
    if (consumers.has(queue)) continue;
    consumers.add(queue);
    changes.push({
      path: [...queues.path, 'consumers'],
      value: { queue },
      append: true,
      summary: `+ ${label([...queues.path, 'consumers'])}: ${show({ queue })}`,
    });
  }
  for (const queue of consumers) {
    if (!wantedConsumers.includes(queue)) {
      warnings.push(`No handler consumes the configured queue consumer ${JSON.stringify(queue)}.`);
    }
  }

  // Durable Objects: a binding and a migration for every exported class.
  const durable = location(config, environment, 'durable_objects', false);
  const bindings = records(isRecord(durable.value) ? durable.value.bindings : undefined);
  const local = bindings.filter((row) => row.script_name === undefined);
  const bound = new Set(
    local.flatMap((row) => (typeof row.class_name === 'string' ? [row.class_name] : [])),
  );
  const names = new Set(
    bindings.flatMap((row) => (typeof row.name === 'string' ? [row.name] : [])),
  );
  const gateways = [
    ...new Set(
      rows('websocket').flatMap((row) => {
        const data = meta(row);
        const options = isRecord(data.options) ? data.options : data;
        return typeof options.binding === 'string' ? [options.binding] : [];
      }),
    ),
  ];
  const unboundGateways = gateways.filter((binding) => !names.has(binding));
  const unbound = facts.exports.durableObjects.filter((name) => !bound.has(name));
  for (const className of unbound) {
    // One gateway binding without a class, and one class without a binding: they belong together.
    const name =
      unbound.length === 1 && unboundGateways.length === 1
        ? (unboundGateways[0] ?? constantCase(className))
        : constantCase(className);
    if (names.has(name)) {
      warnings.push(
        `${className} needs a Durable Object binding, but ${JSON.stringify(name)} is taken: bind it yourself.`,
      );
      continue;
    }
    names.add(name);
    changes.push({
      path: [...durable.path, 'bindings'],
      value: { name, class_name: className },
      append: true,
      summary: `+ ${label([...durable.path, 'bindings'])}: ${show({ name, class_name: className })}`,
    });
  }
  for (const binding of gateways) {
    if (!names.has(binding)) {
      warnings.push(
        `A WebSocket gateway uses the Durable Object binding ${JSON.stringify(binding)}, which no ` +
          'exported class serves: export a VelaWebSocketDurableObject class from the Worker entry.',
      );
    }
  }
  for (const row of local) {
    if (
      typeof row.class_name === 'string' &&
      !facts.exports.durableObjects.includes(row.class_name)
    ) {
      warnings.push(
        `The Durable Object binding ${JSON.stringify(row.name)} names class ` +
          `${JSON.stringify(row.class_name)}, which the Worker entry does not export.`,
      );
    }
  }
  const migrations = location(config, environment, 'migrations', true);
  const steps = records(migrations.value);
  const migrated = new Set<string>();
  for (const step of steps) {
    for (const key of ['new_classes', 'new_sqlite_classes']) {
      for (const name of strings(step[key])) migrated.add(name);
    }
    for (const renamed of records(step.renamed_classes)) {
      if (typeof renamed.to === 'string') migrated.add(renamed.to);
    }
    for (const transferred of records(step.transferred_classes)) {
      if (typeof transferred.to === 'string') migrated.add(transferred.to);
    }
    for (const name of strings(step.deleted_classes)) migrated.delete(name);
  }
  const unmigrated = facts.exports.durableObjects.filter((name) => !migrated.has(name));
  if (unmigrated.length > 0) {
    const tags = steps.map((step) => step.tag);
    const numbers = tags.map((tag) => (typeof tag === 'string' ? /^v(\d+)$/.exec(tag) : null));
    const tag = numbers.every((match) => match !== null)
      ? `v${Math.max(0, ...numbers.map((match) => Number(match?.[1]))) + 1}`
      : `v${steps.length + 1}`;
    const step = { tag, new_sqlite_classes: unmigrated };
    changes.push({
      path: migrations.path,
      value: step,
      append: true,
      summary: `+ ${label(migrations.path)}: ${show(step)}`,
    });
  }

  // Workflows: one entry per exported WorkflowEntrypoint class.
  const workflows = location(config, environment, 'workflows', false);
  const declared = records(workflows.value).filter((row) => row.script_name === undefined);
  const declaredClasses = new Set(
    declared.flatMap((row) => (typeof row.class_name === 'string' ? [row.class_name] : [])),
  );
  for (const className of facts.exports.workflows) {
    if (declaredClasses.has(className)) continue;
    const entry = {
      name: `${worker}-${kebabCase(className)}`,
      binding: constantCase(className),
      class_name: className,
    };
    changes.push({
      path: workflows.path,
      value: entry,
      append: true,
      summary: `+ ${label(workflows.path)}: ${show(entry)}`,
    });
  }
  for (const row of declared) {
    if (typeof row.class_name === 'string' && !facts.exports.workflows.includes(row.class_name)) {
      warnings.push(
        `The Workflow ${JSON.stringify(row.name)} names class ${JSON.stringify(row.class_name)}, ` +
          'which the Worker entry does not export.',
      );
    }
  }

  return { changes, warnings };
}

/** The indentation a JSON document already uses (two spaces by default). */
function formatting(text: string) {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  return {
    insertSpaces: !indent.startsWith('\t'),
    tabSize: indent.startsWith('\t') ? 1 : indent.length,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
}

/** Apply `changes` to a Wrangler JSON/JSONC text in place, keeping its comments and layout. */
export function applyCloudflareSync(text: string, changes: readonly SyncChange[]): string {
  const formattingOptions = formatting(text);
  let result = text;
  for (const change of changes) {
    const root = change.append ? parseTree(result) : undefined;
    const node = root ? findNodeAtLocation(root, [...change.path]) : undefined;
    const [path, value] =
      change.append && node?.type === 'array'
        ? [[...change.path, -1], change.value]
        : [change.path, change.append ? [change.value] : change.value];
    result = applyEdits(result, modify(result, path, value, { formattingOptions }));
  }
  return result;
}
