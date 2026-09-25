import type { DynamicModule, Type } from '@velajs/vela';
import { cloudflareBaseClasses } from './cloudflare-stubs.js';
import { isModuleRoot, isRecord } from './files.js';

/** The key `createCloudflareWorker()` attaches its descriptor under (see `@velajs/cloudflare`). */
export const WORKER_DESCRIPTOR = Symbol.for('vela.cloudflare.worker');

/**
 * The static key a Durable Object class from `VelaDurableObject()` or
 * `VelaWebSocketDurableObject()` carries its descriptor under.
 */
export const DURABLE_OBJECT_DESCRIPTOR = Symbol.for('vela.cloudflare.durableObject');

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

/** Validate one Durable Object descriptor; anything else is not a Vela Durable Object. */
function readDurableObject(value: unknown): DescribedDurableObject | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, host, methods, durableObject } = value;
  if (
    (kind !== 'host' && kind !== 'websocket') ||
    !Array.isArray(methods) ||
    !methods.every((method) => typeof method === 'string') ||
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

/** A Vela Durable Object class the Worker entry exports. */
export interface VelaDurableObjectExport {
  /** The export name: Wrangler's `class_name`. */
  readonly name: string;
  readonly kind: 'host' | 'websocket';
  readonly host?: string;
  readonly methods: readonly string[];
}

/** The platform classes a Worker entry exports, by export name (Wrangler's `class_name`). */
export interface WorkerExports {
  readonly durableObjects: readonly string[];
  readonly workflows: readonly string[];
  readonly entrypoints: readonly string[];
  /** The exported Durable Object classes built by `@velajs/cloudflare`, with what they serve. */
  readonly velaDurableObjects: readonly VelaDurableObjectExport[];
  /**
   * Durable Object classes defined from the Worker's app (`defineCloudflareApp`)
   * that no export extends, by what they serve: `CounterHost`, or `WebSocket`.
   */
  readonly unexportedDurableObjects: readonly string[];
}

/** How a Durable Object class the app defines is named in messages. */
export function describeDurableObject(
  described: Pick<DescribedDurableObject, 'kind' | 'host'>,
): string {
  return described.kind === 'websocket' ? 'WebSocket' : (described.host ?? 'host');
}

/**
 * Classify the named class exports of a Worker entry by the platform class
 * they extend; `load` is the module loader that imported the entry. Durable
 * Object classes `@velajs/cloudflare` built carry what they serve, and the
 * Worker's app lists the Durable Object classes defined from it.
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
      } else if (prototype instanceof WorkflowEntrypoint) workflows.push(name);
      else if (prototype instanceof WorkerEntrypoint) entrypoints.push(name);
    }
  }
  const worker = isRecord(entry) ? entry.default : undefined;
  const descriptor: unknown =
    typeof worker === 'object' && worker !== null
      ? Reflect.get(worker, WORKER_DESCRIPTOR)
      : undefined;
  const defined: unknown = isRecord(descriptor) ? descriptor.durableObjects : undefined;
  const unexportedDurableObjects = (Array.isArray(defined) ? defined : [])
    .map(readDurableObject)
    .filter((described): described is DescribedDurableObject => described !== undefined)
    .filter(
      ({ durableObject }) =>
        !exportedClasses.some(
          (exported) =>
            exported === durableObject ||
            Object.prototype.isPrototypeOf.call(durableObject, exported),
        ),
    )
    .map(describeDurableObject);
  return { durableObjects, workflows, entrypoints, velaDurableObjects, unexportedDurableObjects };
}
