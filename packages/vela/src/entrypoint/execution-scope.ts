import type { Container } from '../container/container';
import { InjectionToken } from '../container/types';

/** Work owned by one invocation, never by an ambient or process-global context. */
export interface ExecutionLifetime {
  /** Generated correlation identifier. It conveys no authentication authority. */
  readonly id: string;
  /** Invocation start time in Unix milliseconds. */
  readonly startedAt: number;
  /** Cooperative cancellation; aborting does not dispose resources still in use. */
  readonly signal: AbortSignal | undefined;
  readonly active: boolean;
  /** Start work when the handler settles; nested managed work is drained too. */
  defer(work: () => unknown | Promise<unknown>): void;
  /** Retain resources for already-started work and observe rejection immediately. */
  waitUntil(work: Promise<unknown>): void;
}

export const EXECUTION_LIFETIME = /* @__PURE__ */ new InjectionToken<ExecutionLifetime>(
  'vela.ExecutionLifetime',
);

export interface ExecutionScopeOptions {
  readonly signal?: AbortSignal;
}

export interface ExecutionScope {
  readonly container: Container;
  readonly lifetime: ExecutionLifetime;
  /**
   * Start draining, then dispose after all work and the optional body/transport
   * boundary settle. The first call selects the boundary; repeated calls return
   * the same promise. Failures remain observable after every task is settled.
   */
  finish(waitFor?: Promise<unknown>): Promise<void>;
}

type SettledWork = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

/** @internal Separate write/finalization authority from the injected lifetime. */
class ManagedLifetime implements ExecutionLifetime {
  readonly id = crypto.randomUUID();
  readonly startedAt = Date.now();
  readonly signal: AbortSignal | undefined;
  readonly #container: Container;
  #active = true;
  #pending: Array<() => unknown | Promise<unknown>> = [];
  #completion: Promise<void> | undefined;
  #wake: (() => void) | undefined;

  constructor(container: Container, options: ExecutionScopeOptions) {
    this.#container = container;
    this.signal = options.signal;
  }

  get active(): boolean {
    return this.#active;
  }

  defer(work: () => unknown | Promise<unknown>): void {
    this.#assertActive();
    if (typeof work !== 'function') throw new TypeError('Deferred work must be a function.');
    this.#pending.push(work);
    this.#notify();
  }

  waitUntil(work: Promise<unknown>): void {
    this.#assertActive();
    // Convert rejection to data now, even if a previous deferred callback is
    // blocked and this promise will only be drained much later.
    const observed = Promise.resolve(work).then<SettledWork, SettledWork>(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error }),
    );
    this.defer(async () => {
      const outcome = await observed;
      if (!outcome.ok) throw outcome.error;
    });
  }

  finish(waitFor?: Promise<unknown>): Promise<void> {
    this.#completion ??= Promise.resolve().then(() => this.#drain(waitFor));
    return this.#completion;
  }

  #assertActive(): void {
    if (!this.#active) throw new Error('Execution lifetime is closed.');
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  async #drain(waitFor?: Promise<unknown>): Promise<void> {
    const errors: unknown[] = [];
    let boundarySettled = waitFor === undefined;
    if (waitFor !== undefined) {
      void Promise.resolve(waitFor).then(
        () => {
          boundarySettled = true;
          this.#notify();
          return undefined;
        },
        (error: unknown) => {
          errors.push(error);
          boundarySettled = true;
          this.#notify();
          return undefined;
        },
      );
    }

    while (true) {
      // Snapshotting releases completed callbacks and allows callbacks to
      // append another batch without replaying already-started work.
      const pending = this.#pending;
      this.#pending = [];
      for (const work of pending) {
        try {
          // Deferred callbacks are ordered and may append later callbacks.
          // eslint-disable-next-line no-await-in-loop
          await work();
        } catch (error) {
          errors.push(error);
        }
      }
      if (this.#pending.length > 0) continue;
      if (boundarySettled) break;
      // Sleep until new managed work or the transport boundary settles.
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }

    this.#active = false;
    try {
      // Always close, including scopes containing no disposable providers.
      await this.#container.dispose();
    } catch (error) {
      errors.push(error);
    }
    throwCompletionErrors(errors);
  }
}

const lifetimes = new WeakMap<Container, ManagedLifetime>();

/** Create a child scope; HTTP adapters may additionally seed REQUEST_CONTEXT. */
export function createExecutionScope(
  container: Container,
  options: ExecutionScopeOptions = {},
): ExecutionScope {
  const child = container.createChild();
  const lifetime = new ManagedLifetime(child, options);
  child.setRequestInstance(EXECUTION_LIFETIME, lifetime);
  lifetimes.set(child, lifetime);
  return { container: child, lifetime, finish: (waitFor) => lifetime.finish(waitFor) };
}

/** @internal Reject resolution after an invocation has closed. */
export function assertExecutionScopeActive(container: Container): void {
  if (lifetimes.get(container)?.active === false) throw new Error('Execution lifetime is closed.');
}

/** An explicit read path; closed and unmanaged scopes have no active lifetime. */
export function getExecutionLifetime(container: Container): ExecutionLifetime | undefined {
  const lifetime = lifetimes.get(container);
  return lifetime?.active ? lifetime : undefined;
}

/** Finalize a child created by createExecutionScope. */
export function finishExecutionScope(
  container: Container,
  waitFor?: Promise<unknown>,
): Promise<void> {
  const lifetime = lifetimes.get(container);
  if (!lifetime) return Promise.reject(new Error('Container has no managed execution scope.'));
  return lifetime.finish(waitFor);
}

/**
 * Run one non-HTTP invocation in a fresh child. Both handler and managed work
 * settle before disposal, on success or failure. REQUEST_CONTEXT is deliberately
 * not seeded: no synthetic HTTP request or authority is inherited.
 */
export async function runInEntrypointScope<T>(
  container: Container,
  fn: (scope: Container, lifetime: ExecutionLifetime) => T | Promise<T>,
  options: ExecutionScopeOptions = {},
): Promise<T> {
  const scope = createExecutionScope(container, options);
  let result: T;
  try {
    result = await fn(scope.container, scope.lifetime);
  } catch (error) {
    try {
      await scope.finish();
    } catch (completionError) {
      // Both caught failures are retained in AggregateError.errors.
      // eslint-disable-next-line preserve-caught-error
      throw new AggregateError([error, completionError], 'Invocation and completion failed.', {
        cause: completionError,
      });
    }
    throw error;
  }
  await scope.finish();
  return result;
}

function throwCompletionErrors(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Execution completion failed.');
}
