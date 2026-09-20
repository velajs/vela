import type { Type } from '@velajs/vela';

/** A static module, or a module graph built from this Worker's native environment. */
export type CloudflareRoot<T extends object> = Type | { create(env: T): Type };

export function resolveCloudflareRoot<T extends object>(root: CloudflareRoot<T>, env: T): Type {
  return typeof root === 'function' ? root : root.create(env);
}
