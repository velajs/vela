import { Injectable, Inject } from '@velajs/vela';
import type { BindingRef } from '../binding-ref';
import { VECTORIZE_BINDING_REF } from '../tokens';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VectorizeBinding = { query: Function; insert: Function; upsert: Function; getByIds: Function; deleteByIds: Function; describe: Function } & Record<string, any>;

/**
 * Wrapper around Cloudflare Vectorize Index.
 * Injected via `VectorizeModule.forRoot({ binding: 'EMBEDDINGS' })`.
 */
@Injectable()
export class VectorizeService {
  constructor(@Inject(VECTORIZE_BINDING_REF) private ref: BindingRef) {}

  /** Access the raw VectorizeIndex binding directly. */
  get index(): VectorizeBinding {
    return this.ref.value as VectorizeBinding;
  }

  query(vector: number[], options?: Record<string, unknown>): Promise<unknown> {
    return this.index.query(vector, options);
  }

  insert(vectors: unknown[]): Promise<unknown> {
    return this.index.insert(vectors);
  }

  upsert(vectors: unknown[]): Promise<unknown> {
    return this.index.upsert(vectors);
  }

  getByIds(ids: string[]): Promise<unknown> {
    return this.index.getByIds(ids);
  }

  deleteByIds(ids: string[]): Promise<unknown> {
    return this.index.deleteByIds(ids);
  }

  describe(): Promise<unknown> {
    return this.index.describe();
  }
}
