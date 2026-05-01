import { Injectable, Inject } from '@velajs/vela';
import type { BindingRef } from '../binding-ref';
import { KV_BINDING_REF } from '../tokens';

/**
 * Wrapper around a Cloudflare KV namespace binding.
 * Use `kv.namespace.get(...)`, `kv.namespace.put(...)`, etc. — the namespace
 * is the standard @cloudflare/workers-types `KVNamespace`.
 */
@Injectable()
export class KVService {
  constructor(@Inject(KV_BINDING_REF) private ref: BindingRef<KVNamespace>) {}

  get namespace(): KVNamespace {
    return this.ref.value;
  }
}
