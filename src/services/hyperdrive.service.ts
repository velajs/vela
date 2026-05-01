import { Injectable, Inject } from '@velajs/vela';
import type { BindingRef } from '../binding-ref';
import { HYPERDRIVE_BINDING_REF } from '../tokens';

@Injectable()
export class HyperdriveService {
  constructor(@Inject(HYPERDRIVE_BINDING_REF) private ref: BindingRef<Hyperdrive>) {}

  get binding(): Hyperdrive {
    return this.ref.value;
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
