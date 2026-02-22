import { Injectable, Inject } from '@velajs/vela';
import type { BindingRef } from '../binding-ref';
import { R2_BINDING_REF } from '../tokens';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R2Binding = Record<string, any>;

/**
 * Wrapper around Cloudflare R2 Bucket.
 * Injected via `R2Module.forRoot({ binding: 'ASSETS' })`.
 */
@Injectable()
export class R2Service {
  constructor(@Inject(R2_BINDING_REF) private ref: BindingRef) {}

  /** Access the raw R2Bucket binding directly. */
  get bucket(): R2Binding {
    return this.ref.value as R2Binding;
  }

  get(key: string, options?: Record<string, unknown>): Promise<unknown> {
    return this.bucket.get(key, options);
  }

  head(key: string): Promise<unknown> {
    return this.bucket.head(key);
  }

  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.bucket.put(key, value, options);
  }

  delete(keys: string | string[]): Promise<void> {
    return this.bucket.delete(keys);
  }

  list(options?: Record<string, unknown>): Promise<unknown> {
    return this.bucket.list(options);
  }
}
