import { Module, type DynamicModule, type Type } from '@velajs/vela';

/** A static module, or a module graph built from this Worker's native environment. */
export type CloudflareRoot<T extends object> =
  | Type
  | DynamicModule
  | { create(env: T): Type | DynamicModule | Promise<Type | DynamicModule> };

export async function resolveCloudflareRoot<T extends object>(
  root: CloudflareRoot<T>,
  env: T,
): Promise<Type> {
  const resolved = typeof root === 'object' && 'create' in root ? await root.create(env) : root;
  if (typeof resolved === 'function') return resolved;
  // Preserve the dynamic root's imports, providers, exports and instance key.
  class WorkerRoot {}
  Module({ imports: [resolved] })(WorkerRoot);
  return WorkerRoot;
}
