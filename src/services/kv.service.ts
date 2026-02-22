import { Injectable, Inject } from '@velajs/vela';
import type { BindingRef } from '../binding-ref';
import { KV_BINDING_REF } from '../tokens';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KVBinding = { get: Function; getWithMetadata: Function; put: Function; delete: Function; list: Function } & Record<string, any>;

/**
 * Wrapper around Cloudflare KV Namespace.
 * Injected via `KVModule.forRoot({ binding: 'MY_KV' })`.
 */
@Injectable()
export class KVService {
  constructor(@Inject(KV_BINDING_REF) private ref: BindingRef) {}

  /** Access the raw KVNamespace binding directly. */
  get namespace(): KVBinding {
    return this.ref.value as KVBinding;
  }

  get(key: string, typeOrOptions?: string | Record<string, unknown>): Promise<unknown> {
    return this.namespace.get(key, typeOrOptions);
  }

  getWithMetadata(
    key: string,
    typeOrOptions?: string | Record<string, unknown>,
  ): Promise<unknown> {
    return this.namespace.getWithMetadata(key, typeOrOptions);
  }

  put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: Record<string, unknown>,
  ): Promise<void> {
    return this.namespace.put(key, value, options);
  }

  delete(key: string): Promise<void> {
    return this.namespace.delete(key);
  }

  list(options?: Record<string, unknown>): Promise<unknown> {
    return this.namespace.list(options);
  }
}
