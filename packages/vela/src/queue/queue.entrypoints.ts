import { Container, Inject, Injectable } from '../index';
import type { DiscoveryService, Entrypoint } from '../index';
import { QueueDispatchBinding } from './queue.binding';
import { QueueRegistry } from './queue.registry';
import { QUEUE_DRIVER, queueToken } from './queue.tokens';
import type { QueueDriver } from './queue.types';

/**
 * A normal class provider makes async transport configuration discoverable at
 * bootstrap. It contributes the driver's platform routes (a native consumer)
 * and one portable `queue:registration` entrypoint per registered queue, whose
 * `{ name, binding?, consumers }` meta deployment checks read.
 */
@Injectable()
export class QueueTransportEntrypoints {
  constructor(
    @Inject(Container) private readonly container: Container,
    @Inject(QUEUE_DRIVER) private readonly driver: QueueDriver,
    @Inject(QueueDispatchBinding) private readonly binding: QueueDispatchBinding,
    @Inject(QueueRegistry) private readonly queues: QueueRegistry,
  ) {}

  async collectEntrypoints(discovery: DiscoveryService): Promise<Entrypoint[]> {
    const registrations = discovery.getRegistrations({ metadataOnly: true });
    let owner: string | undefined;
    for (const registration of registrations) {
      if (registration.token !== QueueTransportEntrypoints) continue;
      const instance = await this.container.resolveAsync(registration.token, registration.moduleId);
      if (instance === this) owner = registration.moduleId;
    }
    if (!owner) throw new Error('Queue transport has no module owner.');
    const moduleId = owner;
    const routes: Entrypoint[] = (this.driver.entrypoints ?? []).map((route) => ({
      kind: route.kind,
      token: QueueTransportEntrypoints,
      moduleId,
      instance: this,
      methodName: 'consume',
      meta: route.meta,
    }));
    const declarations: Entrypoint[] = this.queues.all().map((queue) => ({
      kind: 'queue:registration',
      token: queueToken(queue.name),
      moduleId: this.container.getOwnerModuleIds(queueToken(queue.name))[0],
      instance: undefined,
      meta: {
        name: queue.name,
        ...(queue.binding === undefined ? {} : { binding: queue.binding }),
        consumers: [...queue.consumers],
      },
    }));
    return [...routes, ...declarations];
  }

  async consume(payload: unknown): Promise<void> {
    if (!this.driver.consume) throw new Error('Queue driver has no native consumer.');
    await this.driver.consume(payload, (job) => this.binding.dispatch(job));
  }
}
