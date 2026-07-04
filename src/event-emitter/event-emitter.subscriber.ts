import { Injectable, Inject } from '../container/index';
import { DiscoveryService } from '../discovery/discovery.service';
import type { OnApplicationBootstrap } from '../lifecycle/index';
import { EventEmitter } from './event-emitter.service';
import { ON_EVENT_METADATA } from './event-emitter.tokens';
import type { OnEventMetadata } from './event-emitter.types';

@Injectable()
export class EventEmitterSubscriber implements OnApplicationBootstrap {
  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    private emitter: EventEmitter,
  ) {}

  onApplicationBootstrap(): void {
    for (const found of this.discovery.methodsWithMeta<OnEventMetadata>(ON_EVENT_METADATA)) {
      const instance = found.class.instance;
      if (!instance) continue;
      const method = (instance as Record<string | symbol, unknown>)[found.methodName];
      if (typeof method === 'function') {
        this.emitter.on(found.meta.event, (...args: unknown[]) => method.apply(instance, args));
      }
    }
  }
}
