import { resolveEntrypoint } from '../entrypoint/execution-context';
import { Scope } from '../constants';
import { Container } from '../container/container';
import { Injectable, Inject } from '../container/index';
import { DiscoveryService } from '../discovery/discovery.service';
import { runInEntrypointScope } from '../entrypoint/execution-scope';
import type { OnApplicationBootstrap } from '../lifecycle/index';
import { EventEmitter } from './event-emitter.service';
import { ON_EVENT_METADATA } from './event-emitter.tokens';
import type { EventHandler, OnEventMetadata } from './event-emitter.types';

@Injectable()
export class EventEmitterSubscriber implements OnApplicationBootstrap {
  readonly #discovery: DiscoveryService;
  readonly #emitter: EventEmitter;
  readonly #root: Container | undefined;
  readonly #subscriptions: Array<{ event: string; handler: EventHandler }> = [];

  constructor(
    @Inject(DiscoveryService) discovery: DiscoveryService,
    @Inject(EventEmitter) emitter: EventEmitter,
    @Inject(Container) root?: Container,
  ) {
    this.#discovery = discovery;
    this.#emitter = emitter;
    this.#root = root;
  }

  onApplicationBootstrap(): void {
    for (const found of this.#discovery.registeredMethodsWithMeta<OnEventMetadata>(
      ON_EVENT_METADATA,
    )) {
      let handler: EventHandler;
      if (found.class.scope === Scope.REQUEST) {
        const root = this.#root;
        if (!root)
          throw new Error('Request-scoped event listeners require an application container');
        handler = (...args) =>
          runInEntrypointScope(root, async (scope) => {
            const instance = await resolveEntrypoint(scope, {
              token: found.class.token,
              moduleId: found.class.moduleId,
            });
            await invoke(instance, found.methodName, args);
          });
      } else {
        const instance = found.class.instance;
        if (!instance) continue;
        handler = (...args) => invoke(instance, found.methodName, args);
      }
      this.#emitter.on(found.meta.event, handler);
      this.#subscriptions.push({ event: found.meta.event, handler });
    }
  }

  dispose(): void {
    for (const { event, handler } of this.#subscriptions) this.#emitter.off(event, handler);
    this.#subscriptions.length = 0;
  }
}

async function invoke(
  instance: unknown,
  methodName: string | symbol,
  args: unknown[],
): Promise<void> {
  if (instance === null || (typeof instance !== 'object' && typeof instance !== 'function')) {
    throw new TypeError('Invalid event listener instance');
  }
  const method: unknown = Reflect.get(instance, methodName);
  if (typeof method !== 'function')
    throw new TypeError(`Missing event listener '${String(methodName)}'`);
  await Reflect.apply(method, instance, args);
}
