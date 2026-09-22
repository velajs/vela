import { Module, type DynamicModule, type Type } from '@velajs/vela';

/** A static module, or a module graph built from this Worker's native environment. */
export type CloudflareRoot<T extends object> =
  | Type
  | DynamicModule
  | { create(env: T): Type | DynamicModule | Promise<Type | DynamicModule> };

// Classes decorated while a root resolves (the dynamic-root wrapper and
// anything a factory declares) stay in the isolate-global metadata registry,
// along with the values their metadata captures. Resolving once per
// (root, environment) bounds that growth by environments instead of by
// applications, e.g. every Durable Object instance. The weak keys release
// only these cache entries, never the registered classes.
const resolutions = new WeakMap<object, WeakMap<object, Promise<Type>>>();

async function resolveRoot<T extends object>(
  root: Exclude<CloudflareRoot<T>, Type>,
  env: T,
): Promise<Type> {
  const resolved = 'create' in root ? await root.create(env) : root;
  if (typeof resolved === 'function') return resolved;
  // Preserve the dynamic root's imports, providers, exports and instance key.
  class WorkerRoot {}
  Module({ imports: [resolved] })(WorkerRoot);
  return WorkerRoot;
}

function forget(root: object, env: object, pending: Promise<Type>): void {
  const byEnv = resolutions.get(root);
  if (byEnv?.get(env) === pending) byEnv.delete(env);
}

/**
 * The module graph for one environment, shared by every application built
 * from it. Concurrent callers share one resolution; a rejected factory is
 * evicted so the next caller runs it again.
 */
export function resolveCloudflareRoot<T extends object>(
  root: CloudflareRoot<T>,
  env: T,
): Promise<Type> {
  if (typeof root === 'function') return Promise.resolve(root);
  let byEnv = resolutions.get(root);
  if (!byEnv) {
    byEnv = new WeakMap();
    resolutions.set(root, byEnv);
  }
  const existing = byEnv.get(env);
  if (existing) return existing;
  const pending = resolveRoot(root, env);
  byEnv.set(env, pending);
  void pending.catch(() => forget(root, env, pending));
  return pending;
}

/**
 * Build one application from the shared resolution. A failed build evicts it,
 * so the next bootstrap for this environment runs the factory again.
 */
export async function bootstrapCloudflareRoot<T extends object, R>(
  root: CloudflareRoot<T>,
  env: T,
  build: (rootModule: Type) => Promise<R>,
): Promise<R> {
  const pending = resolveCloudflareRoot(root, env);
  const rootModule = await pending;
  try {
    return await build(rootModule);
  } catch (error) {
    forget(root, env, pending);
    throw error;
  }
}
