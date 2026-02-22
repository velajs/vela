import { Injectable, Inject } from '@velajs/vela';
import type { BindingRef } from '../binding-ref';
import { D1_BINDING_REF } from '../tokens';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type D1Binding = { prepare: Function; batch: Function; exec: Function; dump: Function } & Record<string, any>;

/**
 * Wrapper around Cloudflare D1 Database.
 * Injected via `D1Module.forRoot({ binding: 'DB' })`.
 */
@Injectable()
export class D1Service {
  constructor(@Inject(D1_BINDING_REF) private ref: BindingRef) {}

  /** Access the raw D1Database binding directly. */
  get database(): D1Binding {
    return this.ref.value as D1Binding;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prepare(query: string): any {
    return this.database.prepare(query);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  batch(statements: unknown[]): Promise<any[]> {
    return this.database.batch(statements);
  }

  exec(query: string): Promise<unknown> {
    return this.database.exec(query);
  }

  dump(): Promise<ArrayBuffer> {
    return this.database.dump();
  }
}
