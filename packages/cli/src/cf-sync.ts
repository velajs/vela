import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
  type Edit,
  type JSONPath,
  type Node as JsonNode,
} from 'jsonc-parser';
import { bindingInventory } from './project/bindings.js';
import { cronDialectAmbiguity, parseCronMetadata } from '@velajs/vela/module-kit';
import type { EntrypointRow } from './introspect.js';
import { isRecord } from './project/files.js';
import { definitionOf, type UnexportedClass, type WorkerExports } from './project/worker-entry.js';
import { environmentSection, wranglerWorkerName, type WranglerConfig } from './project/wrangler.js';

/** What the application declares, as `vela cf sync` compares it with Wrangler. */
export interface CloudflareFacts {
  /** `vela entrypoint list --json` rows. */
  readonly entrypoints: readonly EntrypointRow[];
  /** The platform classes the Worker entry exports. */
  readonly exports: WorkerExports;
}

/**
 * One edit of the Wrangler file: `append` adds `value` to the array at `path`
 * (creating the array when there is none); `remove` deletes the element
 * `value` at `path`, whose last segment is its index in the file as read.
 */
export interface SyncChange {
  readonly path: JSONPath;
  readonly value: unknown;
  readonly op: 'append' | 'remove';
  /** One line for people: `+ queues.consumers: { "queue": "jobs" }`. */
  readonly summary: string;
}

export interface SyncPlan {
  readonly changes: readonly SyncChange[];
  /**
   * What the command reports without changing: what it cannot fix itself, and
   * cron triggers no `@Cron` job declares unless `prune` removes them.
   */
  readonly warnings: readonly string[];
}

export interface SyncOptions {
  /**
   * Remove the cron triggers no `@Cron` job declares. Off by default: a Worker
   * entry with its own `scheduled` handler may serve them.
   */
  readonly prune?: boolean;
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

// JSON.stringify writes no whitespace before a line break, and string values
// cannot hold a raw one, so only the indentation after each break needs folding.
const show = (value: unknown): string => JSON.stringify(value, null, 1).replace(/\n */g, ' ');

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
 * `QueueModule.forFeature([{ binding }])`, consumers for the queues its
 * processors and `@QueueConsumer` handlers read, and Durable Object bindings,
 * migrations and Workflows for the classes the Worker entry exports. It warns
 * about the Vela classes the app defines but the entry does not export, and
 * about service bindings to an entrypoint of this Worker the entry does not
 * export.
 */
export function planCloudflareSync(
  config: WranglerConfig,
  environment: string | undefined,
  facts: CloudflareFacts,
  options: SyncOptions = {},
): SyncPlan {
  const changes: SyncChange[] = [];
  const warnings: string[] = [];
  const worker = wranglerWorkerName(config, environment);
  const occupied = new Set(
    bindingInventory(config.root, environmentSection(config, environment)).map(
      (binding) => binding.name,
    ),
  );
  // `vela entrypoint list` lists a declared kind with no entries as a placeholder row.
  const rows = (kind: string) =>
    facts.entrypoints.filter(
      (row) => row.kind === kind && !(row.target === '(no entrypoints)' && row.meta === ''),
    );

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
  // One edit per trigger, so the comments of the array and of the triggers kept stay.
  const triggers = location(config, environment, 'triggers', true);
  const current: unknown = isRecord(triggers.value) ? triggers.value.crons : undefined;
  const path = [...triggers.path, 'crons'];
  for (const cron of crons) {
    if (strings(current).includes(cron)) continue;
    changes.push({
      path,
      value: cron,
      op: 'append',
      summary: `+ ${label(path)}: ${JSON.stringify(cron)}`,
    });
  }
  // Last first, so each index still names the element read from the file.
  const listed: unknown[] = Array.isArray(current) ? current : [];
  const undeclared: string[] = [];
  for (let index = listed.length - 1; index >= 0; index--) {
    const cron = listed[index];
    if (typeof cron !== 'string' || crons.includes(cron)) continue;
    if (!options.prune) {
      undeclared.unshift(cron);
      continue;
    }
    changes.push({
      path: [...path, index],
      value: cron,
      op: 'remove',
      summary: `- ${label(path)}: ${JSON.stringify(cron)} (no @Cron job declares it)`,
    });
  }
  // A Worker entry with its own scheduled handler may serve them.
  for (const cron of undeclared) {
    warnings.push(
      `${label(path)}: ${JSON.stringify(cron)} is not declared by any @Cron job; kept (pass --prune to remove it).`,
    );
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
    if (occupied.has(binding)) {
      warnings.push(
        `Queue ${JSON.stringify(name)} needs binding ${JSON.stringify(binding)}, but that name is taken: bind it yourself.`,
      );
      continue;
    }
    occupied.add(binding);
    const queue = registration.consumers[0] ?? `${worker}-${name}`;
    producers.set(binding, queue);
    changes.push({
      path: [...queues.path, 'producers'],
      value: { binding, queue },
      op: 'append',
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
        `@Processor(${JSON.stringify(name)}) has no QueueModule.forFeature([{ name: ` +
          `${JSON.stringify(name)} }]), so no consumer is added for it.`,
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
          'QueueModule.forFeature([{ name, consumer }]).',
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
      op: 'append',
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
  // A WebSocket Durable Object class serves gateway rooms; other Vela classes never do.
  const kindOf = (className: string) =>
    facts.exports.velaDurableObjects.find((described) => described.name === className)?.kind;
  const roomClasses = unbound.filter((className) => kindOf(className) !== 'host');
  const websocketClasses = unbound.filter((className) => kindOf(className) === 'websocket');
  const gatewayClass =
    unboundGateways.length !== 1
      ? undefined
      : websocketClasses.length === 1
        ? websocketClasses[0]
        : roomClasses.length === 1
          ? roomClasses[0]
          : undefined;
  for (const className of unbound) {
    // One gateway binding without a class, and one class that can serve it: they belong together.
    const name =
      className === gatewayClass
        ? (unboundGateways[0] ?? constantCase(className))
        : constantCase(className);
    if (occupied.has(name)) {
      warnings.push(
        `${className} needs a Durable Object binding, but ${JSON.stringify(name)} is taken: bind it yourself.`,
      );
      continue;
    }
    names.add(name);
    occupied.add(name);
    changes.push({
      path: [...durable.path, 'bindings'],
      value: { name, class_name: className },
      op: 'append',
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
  // The class exists, with its rpc list: it only needs exporting.
  const purpose: Record<UnexportedClass['kind'], string> = {
    'durable-object': 'under its Wrangler class_name so Wrangler can bind it',
    workflow: 'under its Wrangler class_name so a workflows binding can run it',
    entrypoint: 'under the name service bindings give as their entrypoint',
  };
  const classLabel: Record<UnexportedClass['kind'], string> = {
    'durable-object': 'a Durable Object class',
    workflow: 'a Workflow class',
    entrypoint: 'a service entrypoint class',
  };
  for (const described of facts.exports.unexported) {
    warnings.push(
      `The app defines ${classLabel[described.kind]}, ${definitionOf(described)}, that the Worker ` +
        `entry does not export: export that class from the Worker entry ${purpose[described.kind]}.`,
    );
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
      op: 'append',
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
    if (occupied.has(entry.binding)) {
      warnings.push(
        `${className} needs a Workflow binding, but ${JSON.stringify(entry.binding)} is taken: bind it yourself.`,
      );
      continue;
    }
    occupied.add(entry.binding);
    changes.push({
      path: workflows.path,
      value: entry,
      op: 'append',
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

  // Services: a binding to this Worker's own entrypoint needs the Worker entry to export it.
  const services = location(config, environment, 'services', false);
  for (const binding of records(services.value)) {
    if (binding.service !== worker || typeof binding.entrypoint !== 'string') continue;
    if (facts.exports.entrypoints.includes(binding.entrypoint)) continue;
    warnings.push(
      `The service binding ${JSON.stringify(binding.binding)} names entrypoint ` +
        `${JSON.stringify(binding.entrypoint)} of this Worker, which the Worker entry does not export.`,
    );
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

/** The offset of the first character after `from` that is neither whitespace nor a comment. */
function skipTrivia(text: string, from: number): number {
  let offset = from;
  for (;;) {
    while (offset < text.length && /\s/.test(text.charAt(offset))) offset++;
    if (text.startsWith('//', offset)) {
      const end = text.indexOf('\n', offset);
      offset = end === -1 ? text.length : end;
    } else if (text.startsWith('/*', offset)) {
      const end = text.indexOf('*/', offset + 2);
      offset = end === -1 ? text.length : end + 2;
    } else {
      return offset;
    }
  }
}

/** Whether `text` holds at most one comment besides whitespace. */
const onlyComment = (text: string): boolean =>
  /^[ \t]*(?:\/\/.*|\/\*(?:[^*]|\*(?!\/))*\*\/[ \t]*)?\r?$/.test(text);

/**
 * Remove element `index` of `array` with its separating comma. An element on a
 * line of its own goes with that line (and a comment trailing it); comments on
 * other lines stay.
 */
function removeElement(text: string, array: JsonNode, index: number): Edit[] {
  const children = array.children ?? [];
  const child = children[index];
  if (child === undefined) return [];
  const start = child.offset;
  const end = child.offset + child.length;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const ownLine = text.slice(lineStart, start).trim() === '';
  const lineEnd = (from: number): number => {
    const newline = text.indexOf('\n', from);
    return newline === -1 ? text.length : newline + 1;
  };
  const wholeLine = (after: number): Edit | undefined => {
    const stop = lineEnd(after);
    return ownLine && onlyComment(text.slice(after, stop).replace(/\n$/, ''))
      ? { offset: lineStart, length: stop - lineStart, content: '' }
      : undefined;
  };
  const next = skipTrivia(text, end);
  if (text.charAt(next) === ',') {
    const line = wholeLine(next + 1);
    if (line) return [line];
    let stop = next + 1;
    while (text.charAt(stop) === ' ' || text.charAt(stop) === '\t') stop++;
    return [{ offset: start, length: stop - start, content: '' }];
  }
  // The last element: the comma after the one before it goes too.
  const previous = children[index - 1];
  const comma = previous === undefined ? -1 : skipTrivia(text, previous.offset + previous.length);
  const separator = comma !== -1 && text.charAt(comma) === ',' ? comma : undefined;
  const line = wholeLine(end);
  if (line) {
    return separator === undefined ? [line] : [{ offset: separator, length: 1, content: '' }, line];
  }
  const from = separator ?? start;
  return [{ offset: from, length: end - from, content: '' }];
}

/** The indentation of the line `offset` is on. */
function indentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
}

/** Whether only whitespace precedes `offset` on its line. */
function startsLine(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return text.slice(lineStart, offset).trim() === '';
}

/** The offset of the line break ending the line `from` is on (the text's end without one). */
function endOfLine(text: string, from: number): number {
  const newline = text.indexOf('\n', from);
  if (newline === -1) return text.length;
  return text.charAt(newline - 1) === '\r' ? newline - 1 : newline;
}

/**
 * The end of the comments trailing `from` on its line: through a line comment
 * to the line break, through block comments (which may run over several
 * lines) to their close.
 */
function trailEnd(text: string, from: number): number {
  let offset = from;
  let at = from;
  for (;;) {
    while (text.charAt(offset) === ' ' || text.charAt(offset) === '\t') offset++;
    if (text.startsWith('//', offset)) return endOfLine(text, offset);
    if (!text.startsWith('/*', offset)) return at;
    const close = text.indexOf('*/', offset + 2);
    if (close === -1) return at;
    offset = close + 2;
    at = offset;
  }
}

/** `value` as JSON on one line: `{ "binding": "EMAILS", "queue": "jobs" }`. */
function inlineJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(', ')}]`;
  if (isRecord(value)) {
    const members = Object.entries(value).map(
      ([key, member]) => `${JSON.stringify(key)}: ${inlineJson(member)}`,
    );
    return members.length === 0 ? '{}' : `{ ${members.join(', ')} }`;
  }
  return JSON.stringify(value);
}

/** How a document lays out what is added to it. */
interface Layout {
  /** One indentation level. */
  readonly unit: string;
  readonly eol: string;
  /** Whether the whole document is on one line. */
  readonly oneLine: boolean;
}

/** An element or member to add, on one line (`indent` undefined) or from a line indented `indent`. */
type Item = (indent: string | undefined, layout: Layout) => string;

/**
 * Insert `item` as the last element or member of `container`, following its
 * layout: after the last one on its line when that one shares a line, else on
 * a line of its own, after the comma and comment that trail the last one. An
 * empty container gets the item on one line unless it starts a line of a
 * multi-line document. Undefined when a comment inside an empty container
 * leaves no obvious place.
 */
function appendTo(
  text: string,
  container: JsonNode,
  item: Item,
  layout: Layout,
): Edit[] | undefined {
  const last = container.children?.at(-1);
  if (last === undefined) {
    const close = container.offset + container.length - 1;
    if (text.slice(container.offset + 1, close).trim() !== '') return undefined;
    const [open, end] = container.type === 'array' ? ['[', ']'] : ['{ ', ' }'];
    const owner = container.parent?.type === 'property' ? container.parent : container;
    let content = `${open}${item(undefined, layout)}${end}`;
    if (!layout.oneLine && startsLine(text, owner.offset)) {
      const indent = indentAt(text, owner.offset);
      const inner = `${indent}${layout.unit}`;
      content = `${open.trim()}${layout.eol}${inner}${item(inner, layout)}${layout.eol}${indent}${end.trim()}`;
    }
    return [{ offset: container.offset, length: container.length, content }];
  }
  const end = last.offset + last.length;
  if (!startsLine(text, last.offset)) {
    // One line: after the last element and the block comments that trail it there.
    let at = end;
    let offset = end;
    for (;;) {
      while (text.charAt(offset) === ' ' || text.charAt(offset) === '\t') offset++;
      if (!text.startsWith('/*', offset)) break;
      const close = text.indexOf('*/', offset + 2);
      if (close === -1) break;
      offset = close + 2;
      at = offset;
    }
    return text.charAt(offset) === ','
      ? [{ offset: offset + 1, length: 0, content: ` ${item(undefined, layout)},` }]
      : [{ offset: at, length: 0, content: `, ${item(undefined, layout)}` }];
  }
  const indent = indentAt(text, last.offset);
  const line = `${layout.eol}${indent}${item(indent, layout)}`;
  const next = skipTrivia(text, end);
  if (text.charAt(next) === ',') {
    // A trailing comma stays trailing: the new line goes after it and its comment.
    return [{ offset: trailEnd(text, next + 1), length: 0, content: `${line},` }];
  }
  // The comma goes right after the last element, which keeps its own comment.
  return [
    { offset: end, length: 0, content: ',' },
    { offset: trailEnd(text, end), length: 0, content: line },
  ];
}

/**
 * Edits appending `value` to the array at `path`, or creating the array (and
 * the objects above it) as the last member of the deepest object the path
 * reaches. Undefined when the path meets something else.
 */
function appendEdits(
  text: string,
  path: JSONPath,
  value: unknown,
  layout: Layout,
): Edit[] | undefined {
  const root = parseTree(text);
  if (root === undefined) return undefined;
  const node = findNodeAtLocation(root, [...path]);
  if (node !== undefined) {
    if (node.type !== 'array') return undefined;
    return appendTo(text, node, (indent, { unit, eol }) => json(value, indent, unit, eol), layout);
  }
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const parent = findNodeAtLocation(root, path.slice(0, depth));
    if (parent === undefined) continue;
    const [key, ...rest] = path.slice(depth);
    if (parent.type !== 'object' || typeof key !== 'string') return undefined;
    let member: unknown = [value];
    for (const segment of rest.toReversed()) {
      if (typeof segment !== 'string') return undefined;
      member = { [segment]: member };
    }
    return appendTo(
      text,
      parent,
      (indent, { unit, eol }) => `${JSON.stringify(key)}: ${json(member, indent, unit, eol)}`,
      layout,
    );
  }
  return undefined;
}

/** `value` as JSON: on one line, or indented `unit` per level from a line indented `indent`. */
function json(value: unknown, indent: string | undefined, unit: string, eol: string): string {
  if (indent === undefined) return inlineJson(value);
  return JSON.stringify(value, null, unit).split('\n').join(`${eol}${indent}`);
}

/**
 * Apply `changes` to a Wrangler JSON/JSONC text in place, keeping its comments
 * and layout: the appends in order, then the removals, last index first.
 */
export function applyCloudflareSync(text: string, changes: readonly SyncChange[]): string {
  const formattingOptions = formatting(text);
  const layout: Layout = {
    unit: formattingOptions.insertSpaces ? ' '.repeat(formattingOptions.tabSize) : '\t',
    eol: formattingOptions.eol,
    oneLine: !text.trim().includes('\n'),
  };
  let result = text;
  for (const change of changes) {
    if (change.op !== 'append') continue;
    let edits = appendEdits(result, change.path, change.value, layout);
    if (edits === undefined) {
      // A commented empty array, or a path through something else: jsonc-parser edits it.
      const root = parseTree(result);
      edits =
        root && findNodeAtLocation(root, [...change.path])?.type === 'array'
          ? modify(result, [...change.path, -1], change.value, { formattingOptions })
          : modify(result, change.path, [change.value], { formattingOptions });
    }
    result = applyEdits(result, edits);
  }
  const removals = changes
    .filter((change) => change.op === 'remove')
    .toSorted((a, b) => Number(b.path.at(-1)) - Number(a.path.at(-1)));
  for (const change of removals) {
    const index = change.path.at(-1);
    if (typeof index !== 'number') continue;
    const root = parseTree(result);
    const array = root ? findNodeAtLocation(root, change.path.slice(0, -1)) : undefined;
    const element = array?.children?.[index];
    if (array?.type !== 'array' || element === undefined) continue;
    if (getNodeValue(element) !== change.value) {
      throw new Error(
        `The Wrangler file changed while it was synced: ${label(change.path)} is not ${JSON.stringify(change.value)}.`,
      );
    }
    result = applyEdits(result, removeElement(result, array, index));
  }
  return result;
}
