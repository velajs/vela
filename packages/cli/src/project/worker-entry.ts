import type { Type } from '@velajs/vela';
import { cloudflareBaseClasses } from './cloudflare-stubs.js';
import { isRecord } from './files.js';

/** The key `createCloudflareWorker()` attaches its descriptor under (see `@velajs/cloudflare`). */
export const WORKER_DESCRIPTOR = Symbol.for('vela.cloudflare.worker');

/** What `createCloudflareWorker(rootModule, options)` records on the Worker entry. */
export interface WorkerDescriptor {
  /** The root module class; a `DynamicModule` root contributes its `module`. */
  readonly rootClass: Type;
  /** Build the application as the Worker does for `env`, without its Worker handlers. */
  createApplication(env: Record<string, unknown>): Promise<unknown>;
}

function isConstructor(value: unknown): value is Type {
  if (typeof value !== 'function') return false;
  try {
    // Validate constructability without invoking the application's constructor.
    Reflect.construct(Object, [], value);
    return true;
  } catch {
    return false;
  }
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
      `${main} does not default-export createCloudflareWorker(AppModule) from @velajs/cloudflare, ` +
        'so the CLI cannot find the application. Export the Worker that way, or add a ' +
        'vela.config.ts that builds the app (see defineVelaConfig from @velajs/cli/config).',
    );
  }
  const { rootModule, createApplication } = descriptor;
  const rootClass = isRecord(rootModule) ? rootModule.module : rootModule;
  if (!isConstructor(rootClass) || typeof createApplication !== 'function') {
    throw new Error(
      `The Worker descriptor of ${main} is invalid: update @velajs/cloudflare and @velajs/cli together.`,
    );
  }
  return {
    rootClass,
    createApplication: async (env) => Reflect.apply(createApplication, descriptor, [env]),
  };
}

/** The platform classes a Worker entry exports, by export name (Wrangler's `class_name`). */
export interface WorkerExports {
  readonly durableObjects: readonly string[];
  readonly workflows: readonly string[];
  readonly entrypoints: readonly string[];
}

/**
 * Classify the named class exports of a Worker entry by the platform class
 * they extend; `load` is the module loader that imported the entry.
 */
export async function classifyWorkerExports(
  entry: unknown,
  load: (specifier: string) => Promise<unknown>,
): Promise<WorkerExports> {
  const { DurableObject, WorkflowEntrypoint, WorkerEntrypoint } = await cloudflareBaseClasses(load);
  const durableObjects: string[] = [];
  const workflows: string[] = [];
  const entrypoints: string[] = [];
  if (isRecord(entry)) {
    for (const [name, value] of Object.entries(entry)) {
      if (name === 'default' || typeof value !== 'function') continue;
      const prototype: unknown = value.prototype;
      if (prototype instanceof DurableObject) durableObjects.push(name);
      else if (prototype instanceof WorkflowEntrypoint) workflows.push(name);
      else if (prototype instanceof WorkerEntrypoint) entrypoints.push(name);
    }
  }
  return { durableObjects, workflows, entrypoints };
}
