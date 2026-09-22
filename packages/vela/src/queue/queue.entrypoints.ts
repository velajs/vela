import { Container, Inject, Injectable } from '../index';
import type { DiscoveryService, Entrypoint } from '../index';
import { QueueDispatchBinding } from './queue.binding';
import { QUEUE_DRIVER, queueToken } from './queue.tokens';
import type { QueueDriver } from './queue.types';

/** A normal class provider makes async transport configuration discoverable at bootstrap. */
@Injectable()
export class QueueTransportEntrypoints {
  constructor(
    @Inject(Container) private readonly container: Container,
    @Inject(QUEUE_DRIVER) private readonly driver: QueueDriver,
    @Inject(QueueDispatchBinding) private readonly binding: QueueDispatchBinding,
  ) {}

  async collectEntrypoints(discovery: DiscoveryService): Promise<Entrypoint[]> {
    const routes = this.driver.entrypoints ?? [];
    if (routes.length === 0) return [];
    const registrations = discovery.getRegistrations({ metadataOnly: true });
    let owner: string | undefined;
    for (const registration of registrations) {
      if (registration.token !== QueueTransportEntrypoints) continue;
      const instance = await this.container.resolveAsync(registration.token, registration.moduleId);
      if (instance === this) owner = registration.moduleId;
    }
    if (!owner) throw new Error('Queue transport has no module owner.');
    return routes.map((route) => {
      if (!this.container.getOwnerModuleIds(queueToken(route.queue)).includes(owner)) {
        throw new Error(`Transport references unregistered queue '${route.queue}'.`);
      }
      return {
        kind: route.kind,
        token: QueueTransportEntrypoints,
        moduleId: owner,
        instance: this,
        methodName: 'consume',
        meta: route.meta,
      };
    });
  }

  async consume(payload: unknown): Promise<void> {
    if (!this.driver.consume) throw new Error('Queue driver has no native consumer.');
    await this.driver.consume(payload, (job) => this.binding.dispatch(job));
  }
}
