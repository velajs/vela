import { resolveEntrypoint } from '../entrypoint/execution-context';
import { Container } from '../container/container';
import { Inject, Injectable } from '../container/decorators';
import { DiscoveryService } from '../discovery/discovery.service';
import { getExecutionLifetime, runInEntrypointScope } from '../entrypoint/execution-scope';
import { parseSchemaAsync } from '../validation/parse-schema';
import type { EventDefinition, EventInput } from './event-definition';
import { ON_SCOPED_EVENT_METADATA } from './event-emitter.tokens';
import type { ScopedEventMetadata } from './event-emitter.types';

/** Opt-in scoped dispatch. Existing singleton string subscriptions remain application-owned. */
@Injectable()
export class EventDispatcher {
  readonly #root: Container;
  readonly #discovery: DiscoveryService;

  constructor(
    @Inject(Container) root: Container,
    @Inject(DiscoveryService) discovery: DiscoveryService,
  ) {
    this.#root = root;
    this.#discovery = discovery;
  }

  /** Independent invocation; does not inherit request/tenant authority from its caller. */
  async emit<Event extends EventDefinition>(
    event: Event,
    input: EventInput<NoInfer<Event>>,
  ): Promise<void> {
    await runInEntrypointScope(this.#root, (scope) => this.inScope(scope).emit(event, input));
  }

  /** Bind to an existing managed invocation, preserving its tenant providers and disposal owner. */
  inScope(scope: Container): ScopedEventDispatcher {
    const lifetime = getExecutionLifetime(scope);
    if (!lifetime?.active || scope.resolve(Container) !== this.#root) {
      throw new Error('Events require an active execution scope belonging to this application');
    }
    const assertActive = (): void => {
      if (!lifetime.active) throw new Error('The event execution scope has finished');
      lifetime.signal?.throwIfAborted();
    };
    const dispatch = async (event: EventDefinition, input: unknown): Promise<void> => {
      assertActive();
      const listeners = this.#discovery
        .registeredMethodsWithMeta<ScopedEventMetadata>(ON_SCOPED_EVENT_METADATA, {
          metadataOnly: true,
        })
        .filter((listener) => listener.meta.definition.name === event.name);
      for (const listener of listeners) {
        if (listener.meta.definition.schema !== event.schema) {
          throw new TypeError(`Conflicting schemas for event '${event.name}'`);
        }
      }
      const payload = await parseSchemaAsync(event.schema, input);
      assertActive();
      const results = await Promise.allSettled(
        listeners.map(async (listener) => {
          const instance = await resolveEntrypoint(scope, {
            token: listener.class.token,
            moduleId: listener.class.moduleId,
          });
          if (
            instance === null ||
            (typeof instance !== 'object' && typeof instance !== 'function')
          ) {
            throw new TypeError(`Invalid listener for event '${event.name}'`);
          }
          const method: unknown = Reflect.get(instance, listener.methodName);
          if (typeof method !== 'function')
            throw new TypeError(`Missing listener method for event '${event.name}'`);
          await Reflect.apply(method, instance, [payload]);
        }),
      );
      const failures: unknown[] = [];
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, `Event '${event.name}' listeners failed`);
    };
    return Object.freeze({
      emit: <Event extends EventDefinition>(event: Event, input: EventInput<NoInfer<Event>>) =>
        dispatch(event, input),
      emitUnknown: (event: EventDefinition, input: unknown) => dispatch(event, input),
      defer: <Event extends EventDefinition>(
        event: Event,
        input: EventInput<NoInfer<Event>>,
      ): void => {
        assertActive();
        lifetime.defer(() => dispatch(event, input));
      },
    });
  }
}

export interface ScopedEventDispatcher {
  /** Validates once, attempts all matching listeners and settles every result before rejecting. */
  emit<Event extends EventDefinition>(
    event: Event,
    input: EventInput<NoInfer<Event>>,
  ): Promise<void>;
  /** Explicit boundary for values received from outside TypeScript's type system. */
  emitUnknown(event: EventDefinition, input: unknown): Promise<void>;
  /** Runs at invocation completion; failures belong to that invocation's completion promise. */
  defer<Event extends EventDefinition>(event: Event, input: EventInput<NoInfer<Event>>): void;
}
