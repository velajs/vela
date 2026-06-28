import { Inject, Injectable } from '@velajs/vela';
import type { EnvRef } from '../env-ref';
import { ENV_REF } from '../tokens';

/**
 * Injectable access to the full Cloudflare Worker `env` (bindings + vars +
 * secrets).
 *
 * The per-binding services (`D1Service`, `KVService`, …) each expose a single
 * binding, and the `@Env()` param decorator only works inside a request-scoped
 * controller handler. `EnvService` fills the gap: it can be injected into
 * PROVIDER FACTORIES — e.g. `SomeModule.forRootAsync({ inject: [EnvService] })`
 * — so a factory can read secrets/origins without reaching for the request.
 *
 * Reads are lazy. `env` only exists per request, so a factory (which runs at
 * bootstrap) must capture the `EnvService` and read inside its callback:
 *
 * ```ts
 * AuthModule.forRootAsync({
 *   inject: [EnvService],
 *   useFactory: (env: EnvService) => buildAuth(() => env.get<string>('AUTH_SECRET')),
 * });
 * ```
 *
 * Reading eagerly at bootstrap (`env.get(...)` before any request) throws.
 */
@Injectable()
export class EnvService {
  constructor(@Inject(ENV_REF) private ref: EnvRef) {}

  /** The full env record. Throws if read before the first request. */
  get env(): Record<string, unknown> {
    return this.ref.value;
  }

  /** Read a single env entry (binding, var, or secret) by name. */
  get<T = unknown>(key: string): T | undefined {
    return this.ref.value[key] as T | undefined;
  }
}
