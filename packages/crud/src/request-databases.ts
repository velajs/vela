import type { ExecutionLifetime } from '@velajs/vela';
import type { CrudDatabaseRegistry } from './databases';

const leasedRegistries = new WeakSet<CrudDatabaseRegistry>();
const acquiredResources = new WeakSet<object>();

/** One acquisition. Use the registry only until dispose completes. */
export class CrudDatabaseLease {
  readonly databases: CrudDatabaseRegistry;
  #active = true;
  #claimed = false;
  #completion: Promise<void> | undefined;

  /** @internal Prefer acquireCrudDatabases so failed construction also releases. */
  constructor(
    databases: CrudDatabaseRegistry,
    private readonly release: () => void | Promise<void>,
  ) {
    if (leasedRegistries.has(databases))
      throw new Error('Database registry has already been leased');
    this.databases = databases.forApplication(() => {
      if (!this.#active) throw new Error('Request database lease is closed');
    });
    leasedRegistries.add(databases);
  }

  /** @internal Transfer one lease to one managed invocation. */
  async claim(
    lifetime: ExecutionLifetime,
  ): Promise<CrudDatabaseRegistry & { dispose(): Promise<void> }> {
    if (this.#claimed || !this.#active)
      throw new Error('Database lease is already owned or closed');
    if (!lifetime.active) {
      const error = new Error('Execution lifetime is closed');
      try {
        await this.dispose();
      } catch (releaseError) {
        // Both failures are retained in AggregateError.errors.
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError([error, releaseError], 'Database ownership and release failed', {
          cause: error,
        });
      }
      throw error;
    }
    this.#claimed = true;
    return Object.assign(this.databases, { dispose: () => this.dispose() });
  }

  /** Idempotent, including release failure; no retry against a possibly closed client. */
  dispose(): Promise<void> {
    this.#active = false;
    this.#completion ??= Promise.resolve().then(() => this.release());
    return this.#completion;
  }
}

/**
 * Acquire one native resource and construct all adapters/stores from that exact
 * handle. Failure after acquisition releases it; acquire itself owns partial
 * initialization failures. No ambient context, pooling or background cleanup.
 */
export async function acquireCrudDatabases<Handle>(options: {
  acquire(): Handle | Promise<Handle>;
  create(handle: Handle): CrudDatabaseRegistry | Promise<CrudDatabaseRegistry>;
  release(handle: Handle): void | Promise<void>;
  signal?: AbortSignal;
}): Promise<CrudDatabaseLease> {
  options.signal?.throwIfAborted();
  const handle = await options.acquire();
  const reference =
    (typeof handle === 'object' && handle !== null) || typeof handle === 'function'
      ? handle
      : undefined;
  // A bad factory must never release a native object another lease still owns.
  if (reference && acquiredResources.has(reference))
    throw new Error('Native database resource is already acquired');
  if (reference) acquiredResources.add(reference);
  const release = async () => {
    await options.release(handle);
    // A failed release leaves this resource quarantined from later acquisition.
    if (reference) acquiredResources.delete(reference);
  };
  try {
    options.signal?.throwIfAborted();
    const databases = await options.create(handle);
    options.signal?.throwIfAborted();
    return new CrudDatabaseLease(databases, release);
  } catch (error) {
    try {
      await release();
    } catch (releaseError) {
      // Both failures are retained in AggregateError.errors.
      // eslint-disable-next-line preserve-caught-error
      throw new AggregateError([error, releaseError], 'Database construction and release failed', {
        cause: error,
      });
    }
    throw error;
  }
}
