import { Injectable, Inject } from '@velajs/vela';
import type { BindingRef } from '../binding-ref';
import { DO_BINDING_REF } from '../tokens';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DOBinding = { newUniqueId: Function; idFromName: Function; idFromString: Function; get: Function; jurisdiction: Function } & Record<string, any>;

/**
 * Wrapper around Cloudflare DurableObjectNamespace.
 * Injected via `DurableObjectModule.forRoot({ binding: 'COUNTER' })`.
 */
@Injectable()
export class DurableObjectService {
  constructor(@Inject(DO_BINDING_REF) private ref: BindingRef) {}

  /** Access the raw DurableObjectNamespace binding directly. */
  get namespace(): DOBinding {
    return this.ref.value as DOBinding;
  }

  newUniqueId(options?: Record<string, unknown>): unknown {
    return this.namespace.newUniqueId(options);
  }

  idFromName(name: string): unknown {
    return this.namespace.idFromName(name);
  }

  idFromString(hexStr: string): unknown {
    return this.namespace.idFromString(hexStr);
  }

  get(id: unknown): unknown {
    return this.namespace.get(id);
  }

  jurisdiction(name: string): unknown {
    return this.namespace.jurisdiction(name);
  }
}
