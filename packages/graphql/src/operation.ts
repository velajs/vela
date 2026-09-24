import { ForbiddenException, type VelaContext } from '@velajs/vela';
import {
  getRequestContainer,
  getTrustedRequestIdentity,
  resolveErrorReporter,
  type TrustedRequestIdentity,
} from '@velajs/vela/module-kit';
import type { Container } from '@velajs/vela/module-kit';
import type { GraphqlPipeline } from './types';

/** A typed operation-local resource. Factories may return DataLoader or any other cache. */
export class GraphqlLoader<T> {
  readonly #create: (operation: GraphqlOperation) => T | Promise<T>;
  readonly #dispose: ((value: T) => void | Promise<void>) | undefined;
  readonly #values = new WeakMap<GraphqlOperation, Promise<T>>();

  constructor(
    create: (operation: GraphqlOperation) => T | Promise<T>,
    dispose?: (value: T) => void | Promise<void>,
  ) {
    this.#create = create;
    this.#dispose = dispose;
  }

  /** @internal Called by operation.loader; completed operations cannot reopen a cache. */
  get(operation: GraphqlOperation): Promise<T> {
    operation.assertActive();
    const previous = this.#values.get(operation);
    if (previous) return previous;
    const pending = operation.track(() => this.#create(operation));
    this.#values.set(operation, pending);
    operation.onClose(async () => {
      this.#values.delete(operation);
      try {
        const value = await pending;
        await this.#dispose?.(value);
      } catch (error) {
        // A rejected factory is already observed by its caller; disposal failures are reported.
        if (
          await pending.then(
            () => true,
            () => false,
          )
        )
          throw error;
      }
    });
    return pending;
  }
}

/** One query/mutation shares this context, child container and loader ownership. */
export class GraphqlOperation {
  readonly #context: VelaContext;
  readonly #container: Container;
  readonly #identity: TrustedRequestIdentity | undefined;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #cleanup: (() => Promise<void>)[] = [];
  #active = true;
  #finish: Promise<void> | undefined;
  readonly pipeline: GraphqlPipeline;

  constructor(context: VelaContext, pipeline: GraphqlPipeline = {}) {
    this.#context = context;
    this.#container = getRequestContainer(context);
    this.#identity = getTrustedRequestIdentity(context.req.raw);
    this.pipeline = pipeline;
  }

  get request(): Request {
    return this.#context.req.raw;
  }
  get signal(): AbortSignal {
    return this.request.signal;
  }
  get container(): Container {
    this.assertActive();
    return this.#container;
  }
  /** Original managed HTTP host; adapters never synthesize a replacement request. */
  get http(): VelaContext {
    this.assertActive();
    return this.#context;
  }
  get identity(): TrustedRequestIdentity | undefined {
    this.assertActive();
    return this.#identity;
  }

  assertActive(): void {
    if (!this.#active) throw new Error('GraphQL operation has finished');
    this.signal.throwIfAborted();
    if (getTrustedRequestIdentity(this.request) !== this.#identity) {
      throw new ForbiddenException('GraphQL operation identity changed');
    }
  }

  loader<T>(loader: GraphqlLoader<T>): Promise<T> {
    return loader.get(this);
  }

  /** @internal Track every schema resolver, including siblings after a non-null failure. */
  track<T>(work: () => T | Promise<T>): Promise<T> {
    this.assertActive();
    const pending = Promise.resolve().then(work);
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    );
    return pending;
  }

  /** @internal Resources register cleanup while this operation is active. */
  onClose(cleanup: () => Promise<void>): void {
    this.assertActive();
    this.#cleanup.push(cleanup);
  }

  /** @internal Reporting is contained by Vela's existing reporter. */
  report(error: unknown, source: string): void {
    try {
      resolveErrorReporter(this.#container).report(error, {
        edge: 'http',
        source,
        note: 'GraphQL execution',
      });
    } catch {
      // A misconfigured reporter provider must not replace the original public error.
    }
  }

  /** Does not dispose the HTTP child; its framework-owned request lifetime does that. */
  finish(): Promise<void> {
    return (this.#finish ??= this.#close());
  }

  async #close(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled(this.#pending);
    this.#active = false;
    for (const cleanup of this.#cleanup.toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        this.report(error, 'GraphQL loader disposal');
      }
    }
    this.#cleanup.length = 0;
  }
}
