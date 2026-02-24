import { Injectable, Inject } from '../container/index';
import { Container } from '../container/container';
import type { OnApplicationBootstrap } from '../lifecycle/index';
import { EventEmitter } from './event-emitter.service';
import { ON_EVENT_METADATA } from './event-emitter.tokens';
import type { OnEventMetadata } from './event-emitter.types';

@Injectable()
export class EventEmitterSubscriber implements OnApplicationBootstrap {
  constructor(
    @Inject(Container) private container: Container,
    private emitter: EventEmitter,
  ) {}

  onApplicationBootstrap(): void {
    const tokens = this.container.getTokens();

    for (const token of tokens) {
      // Skip non-class tokens
      if (typeof token !== 'function') continue;

      const metadata = Reflect.getMetadata(
        ON_EVENT_METADATA,
        token,
      ) as OnEventMetadata[] | undefined;

      if (!metadata || metadata.length === 0) continue;

      let instance: unknown;
      try {
        instance = this.container.resolve(token);
      } catch {
        continue;
      }

      for (const { event, methodName } of metadata) {
        const method = (instance as Record<string, unknown>)[methodName];
        if (typeof method === 'function') {
          this.emitter.on(event, (...args: unknown[]) =>
            (method as Function).apply(instance, args),
          );
        }
      }
    }
  }
}
