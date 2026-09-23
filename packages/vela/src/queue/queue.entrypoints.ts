import { Container, Inject, Injectable, resolveErrorReporter } from '../index';
import type { DiscoveryService, Entrypoint } from '../index';
import { QueueDispatchBinding } from './queue.binding';
import { isReportedQueueFailure } from './queue.dispatch';
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

  /**
   * Settle one native batch through the driver. Every failure is reported once
   * on the `queue` edge: processor failures where the processor ran, and the
   * transport's own (a message that is not a job, an unregistered or
   * mis-pinned queue, a job no processor handles, a rejected signed re-entry)
   * here. The platform adapter therefore does not report this entrypoint's
   * rejection again.
   */
  async consume(payload: unknown): Promise<void> {
    if (!this.driver.consume) throw new Error('Queue driver has no native consumer.');
    try {
      await this.driver.consume(payload, async (job) => {
        await this.binding.dispatch(job);
      });
    } catch (error) {
      const reporter = resolveErrorReporter(this.container);
      for (const failure of unreported(error)) {
        reporter.report(failure, { edge: 'queue', source: 'QueueTransportEntrypoints.consume' });
      }
      throw error;
    }
  }
}

/** The failures in a batch rejection that no processor already reported. */
function unreported(error: unknown): unknown[] {
  if (isReportedQueueFailure(error)) return [];
  if (error instanceof AggregateError) return error.errors.flatMap(unreported);
  return [error];
}
