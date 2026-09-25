import type { DynamicModule, Type } from '@velajs/vela';
import { cloudflareBaseClasses } from './cloudflare-stubs.js';
import { isModuleRoot, isRecord } from './files.js';
import type { UnexportedClass } from './vela-classes.js';

export { definitionOf, type UnexportedClass } from './vela-classes.js';

/** The key `createCloudflareWorker()` attaches its descriptor under (see `@velajs/cloudflare`). */
export const WORKER_DESCRIPTOR = Symbol.for('vela.cloudflare.worker');

/**
 * The static key a Durable Object class from `VelaDurableObject()` or
 * `VelaWebSocketDurableObject()` carries its descriptor under.
 */
export const DURABLE_OBJECT_DESCRIPTOR = Symbol.for('vela.cloudflare.durableObject');

/** The static key a Workflow class from `VelaWorkflow()` carries its descriptor under. */
export const WORKFLOW_DESCRIPTOR = Symbol.for('vela.cloudflare.workflow');

/** The static key a service entrypoint class from `VelaEntrypoint()` carries its descriptor under. */
export const ENTRYPOINT_DESCRIPTOR = Symbol.for('vela.cloudflare.entrypoint');

/** What `@velajs/cloudflare` records about a Durable Object class it defined. */
export interface DescribedDurableObject {
  /** `host`: `VelaDurableObject(root, Host)`; `websocket`: `VelaWebSocketDurableObject(root)`. */
  readonly kind: 'host' | 'websocket';
  /** The host class's name, for a `host` Durable Object. */
  readonly host?: string;
  /** The RPC methods of the class. */
  readonly methods: readonly string[];
  /** The class the factory returned; an exported class extends it. */
  readonly durableObject: abstract new (...args: never[]) => unknown;
}

/** What `createCloudflareWorker(rootModule, options)` records on the Worker entry. */
export interface WorkerDescriptor {
  /** The root the Worker passes to `createCloudflareWorker()`: a module class or a `DynamicModule`. */
  readonly rootModule: Type | DynamicModule;
  /** Build the application as the Worker does for `env`, without its Worker handlers. */
  createApplication(env: Record<string, unknown>): Promise<unknown>;
}

/** Read and validate the descriptor of a loaded Worker entry module. */
export function readWorkerDescriptor(entry: unknown, main: string): WorkerDescriptor {
  const worker = isRecord(entry) ? entry.default : undefined;
  const descriptor: unknown =
    typeof worker === 'object' && worker !== null
      ? Reflect.get(worker, WORKER_DESCRIPTOR)
      : undefined;
  if (!isRecord(descriptor)) {
    throw new Error(
      `${main} does not default-export createCloudflareWorker(AppModule) or ` +
        'defineCloudflareApp(AppModule).worker from @velajs/cloudflare, so the CLI cannot find ' +
        'the application. Export the Worker that way, or add a vela.config.ts that builds the app ' +
        '(see defineVelaConfig from @velajs/cli/config).',
    );
  }
  const { rootModule, createApplication } = descriptor;
  if (!isModuleRoot(rootModule) || typeof createApplication !== 'function') {
    throw new Error(
      `The Worker descriptor of ${main} is invalid: update @velajs/cloudflare and @velajs/cli together.`,
    );
  }
  return {
    rootModule,
    createApplication: async (env) => Reflect.apply(createApplication, descriptor, [env]),
  };
}

function isClass(value: unknown): value is abstract new (...args: never[]) => unknown {
  return typeof value === 'function';
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Validate one Durable Object descriptor; anything else is not a Vela Durable Object. */
function readDurableObject(value: unknown): DescribedDurableObject | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, host, methods, durableObject } = value;
  if (
    (kind !== 'host' && kind !== 'websocket') ||
    !isStringList(methods) ||
    !isClass(durableObject)
  ) {
    return undefined;
  }
  return {
    kind,
    ...(isClass(host) ? { host: host.name } : {}),
    methods,
    durableObject,
  };
}

/** What `@velajs/cloudflare` records about a Workflow class it defined. */
interface DescribedWorkflow {
  readonly host: string;
  readonly workflow: abstract new (...args: never[]) => unknown;
}

/** Validate one Workflow descriptor; anything else is not a Vela Workflow. */
function readWorkflow(value: unknown): DescribedWorkflow | undefined {
  if (!isRecord(value)) return undefined;
  const { host, workflow } = value;
  if (!isClass(host) || !isClass(workflow)) return undefined;
  return { host: host.name, workflow };
}

/** What `@velajs/cloudflare` records about a service entrypoint class it defined. */
interface DescribedEntrypoint {
  readonly host: string;
  readonly methods: readonly string[];
  readonly entrypoint: abstract new (...args: never[]) => unknown;
}

/** Validate one service entrypoint descriptor; anything else is not a Vela entrypoint. */
function readEntrypoint(value: unknown): DescribedEntrypoint | undefined {
  if (!isRecord(value)) return undefined;
  const { host, methods, entrypoint } = value;
  if (!isClass(host) || !isStringList(methods) || !isClass(entrypoint)) return undefined;
  return { host: host.name, methods, entrypoint };
}

/** A Vela Durable Object class the Worker entry exports. */
export interface VelaDurableObjectExport {
  /** The export name: Wrangler's `class_name`. */
  readonly name: string;
  readonly kind: 'host' | 'websocket';
  readonly host?: string;
  readonly methods: readonly string[];
}

/** A Vela Workflow class (`VelaWorkflow(app, Host)`) the Worker entry exports. */
export interface VelaWorkflowExport {
  /** The export name: the `class_name` of a `workflows` entry. */
  readonly name: string;
  readonly host: string;
}

/** A Vela service entrypoint class (`VelaEntrypoint(app, Host, { rpc })`) the Worker entry exports. */
export interface VelaEntrypointExport {
  /** The export name: the `entrypoint` of a service binding. */
  readonly name: string;
  readonly host: string;
  readonly methods: readonly string[];
}

/** The platform classes a Worker entry exports, by export name (Wrangler's `class_name`). */
export interface WorkerExports {
  readonly durableObjects: readonly string[];
  readonly workflows: readonly string[];
  readonly entrypoints: readonly string[];
  /** The exported Durable Object classes built by `@velajs/cloudflare`, with what they serve. */
  readonly velaDurableObjects: readonly VelaDurableObjectExport[];
  /** The exported Workflow classes built by `@velajs/cloudflare`, with their hosts. */
  readonly velaWorkflows: readonly VelaWorkflowExport[];
  /** The exported service entrypoint classes built by `@velajs/cloudflare`, with their RPC methods. */
  readonly velaEntrypoints: readonly VelaEntrypointExport[];
  /**
   * The Durable Object, Workflow and service entrypoint classes defined from
   * the Worker's app (`defineCloudflareApp`) that no export extends.
   */
  readonly unexported: readonly UnexportedClass[];
}

/** How a Durable Object class the app defines is named in messages. */
export function describeDurableObject(
  described: Pick<DescribedDurableObject, 'kind' | 'host'>,
): string {
  return described.kind === 'websocket' ? 'WebSocket' : (described.host ?? 'host');
}

/** Whether an exported class is, or extends, the class a factory returned. */
function exports(exported: readonly object[], defined: object): boolean {
  return exported.some(
    (candidate) => candidate === defined || Object.prototype.isPrototypeOf.call(defined, candidate),
  );
}

/**
 * Classify the named class exports of a Worker entry by the platform class
 * they extend; `load` is the module loader that imported the entry. Durable
 * Object, Workflow and service entrypoint classes `@velajs/cloudflare` built
 * carry what they serve, and the Worker's app lists the classes defined from
 * it.
 */
export async function classifyWorkerExports(
  entry: unknown,
  load: (specifier: string) => Promise<unknown>,
): Promise<WorkerExports> {
  const { DurableObject, WorkflowEntrypoint, WorkerEntrypoint } = await cloudflareBaseClasses(load);
  const durableObjects: string[] = [];
  const workflows: string[] = [];
  const entrypoints: string[] = [];
  const velaDurableObjects: VelaDurableObjectExport[] = [];
  const velaWorkflows: VelaWorkflowExport[] = [];
  const velaEntrypoints: VelaEntrypointExport[] = [];
  const exportedClasses: object[] = [];
  if (isRecord(entry)) {
    for (const [name, value] of Object.entries(entry)) {
      if (name === 'default' || typeof value !== 'function') continue;
      const prototype: unknown = value.prototype;
      if (prototype instanceof DurableObject) {
        durableObjects.push(name);
        exportedClasses.push(value);
        const described = readDurableObject(Reflect.get(value, DURABLE_OBJECT_DESCRIPTOR));
        if (described) {
          velaDurableObjects.push({
            name,
            kind: described.kind,
            ...(described.host === undefined ? {} : { host: described.host }),
            methods: described.methods,
          });
        }
      } else if (prototype instanceof WorkflowEntrypoint) {
        workflows.push(name);
        exportedClasses.push(value);
        const described = readWorkflow(Reflect.get(value, WORKFLOW_DESCRIPTOR));
        if (described) velaWorkflows.push({ name, host: described.host });
      } else if (prototype instanceof WorkerEntrypoint) {
        entrypoints.push(name);
        exportedClasses.push(value);
        const described = readEntrypoint(Reflect.get(value, ENTRYPOINT_DESCRIPTOR));
        if (described) {
          velaEntrypoints.push({ name, host: described.host, methods: described.methods });
        }
      }
    }
  }
  const worker = isRecord(entry) ? entry.default : undefined;
  const descriptor: unknown =
    typeof worker === 'object' && worker !== null
      ? Reflect.get(worker, WORKER_DESCRIPTOR)
      : undefined;
  const listed = (key: string): unknown[] => {
    const value: unknown = isRecord(descriptor) ? descriptor[key] : undefined;
    return Array.isArray(value) ? value : [];
  };
  const unexported: UnexportedClass[] = [
    ...listed('durableObjects')
      .map(readDurableObject)
      .filter((described) => described !== undefined)
      .filter(({ durableObject }) => !exports(exportedClasses, durableObject))
      .map((described) => ({
        kind: 'durable-object' as const,
        serves: describeDurableObject(described),
        methods: described.kind === 'websocket' ? [] : described.methods,
      })),
    ...listed('workflows')
      .map(readWorkflow)
      .filter((described) => described !== undefined)
      .filter(({ workflow }) => !exports(exportedClasses, workflow))
      .map(({ host }) => ({ kind: 'workflow' as const, serves: host, methods: [] })),
    ...listed('entrypoints')
      .map(readEntrypoint)
      .filter((described) => described !== undefined)
      .filter(({ entrypoint }) => !exports(exportedClasses, entrypoint))
      .map(({ host, methods }) => ({ kind: 'entrypoint' as const, serves: host, methods })),
  ];
  return {
    durableObjects,
    workflows,
    entrypoints,
    velaDurableObjects,
    velaWorkflows,
    velaEntrypoints,
    unexported,
  };
}
