import { Injectable, Inject } from '@velajs/vela';
import type { BindingRef } from '../binding-ref';
import { HYPERDRIVE_BINDING_REF } from '../tokens';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HyperdriveBinding = { connectionString: string; host: string; port: number; user: string; password: string; database: string } & Record<string, any>;

/**
 * Wrapper around Cloudflare Hyperdrive binding.
 * Injected via `HyperdriveModule.forRoot({ binding: 'POSTGRES' })`.
 */
@Injectable()
export class HyperdriveService {
  constructor(@Inject(HYPERDRIVE_BINDING_REF) private ref: BindingRef) {}

  /** Access the raw Hyperdrive binding directly. */
  get binding(): HyperdriveBinding {
    return this.ref.value as HyperdriveBinding;
  }

  get connectionString(): string {
    return this.binding.connectionString;
  }

  get host(): string {
    return this.binding.host;
  }

  get port(): number {
    return this.binding.port;
  }

  get user(): string {
    return this.binding.user;
  }

  get password(): string {
    return this.binding.password;
  }

  get database(): string {
    return this.binding.database;
  }
}
