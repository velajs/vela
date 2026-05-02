import { Injectable, Inject } from '../container/index';
import { Container } from '../container/container';
import type { OnApplicationBootstrap } from '../lifecycle/index';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
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

      const metadata = MetadataRegistry.getCustomClassMeta(
        token as Constructor,
        ON_EVENT_METADATA,
      ) as OnEventMetadata[] | undefined;

      if (!metadata || metadata.length === 0) continue;

      let instance: unknown;
      try {
        instance = this.container.resolve(token);
      } catch (err) {
        const mode = this.container.getDiagnostics();
        if (mode === 'throw') throw err;
        if (mode === 'log') {
          console.warn(
            `[vela] event subscriber discovery: cannot resolve ${token.name || String(token)}:`,
            err,
          );
        }
        continue;
      }

      for (const { event, methodName } of metadata) {
        const method = (instance as Record<string, unknown>)[methodName];
        if (typeof method === 'function') {
          this.emitter.on(event, (...args: unknown[]) => method.apply(instance, args));
        }
      }
    }
  }
}
