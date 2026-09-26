import { InjectionToken } from '@velajs/vela';
import {
  createDiscoverableDecorator,
  DiscoveryService,
  type Container,
} from '@velajs/vela/module-kit';
import { DEFAULT_INBOUND_GATE, snapshotInboundGate, type MailInboundGate } from './inbound/gate';
import { MailError } from './mail.error';
import { MAIL_INBOUND_GATE } from './mail.tokens';

const gateMarker = createDiscoverableDecorator<true>('vela:mail:inbound-gate-registration');

/** Each application snapshots a registration's resolved policy through its own DI owner. */
export class MailInboundGateRegistration {
  readonly snapshot: MailInboundGate | undefined;
  constructor(readonly source: MailInboundGate | undefined) {
    this.snapshot = source === undefined ? undefined : snapshotInboundGate(source);
  }
}
gateMarker(true)(MailInboundGateRegistration);

export async function resolveInboundGate(container: Container): Promise<MailInboundGate> {
  const gates = new Map<MailInboundGate, MailInboundGate>();
  for (const gate of container.resolveAll(MAIL_INBOUND_GATE))
    gates.set(gate, snapshotInboundGate(gate));
  const registrations = container
    .resolve(DiscoveryService)
    .registrationsWithMeta(gateMarker, { metadataOnly: true });
  const resolved = await Promise.all(
    registrations.map(({ moduleId }) =>
      container.resolveAsync(MailInboundGateRegistration, moduleId),
    ),
  );
  for (const { source, snapshot } of resolved) {
    if (!source || !snapshot) continue;
    const previous = gates.get(source);
    if (
      previous &&
      (previous.policy !== snapshot.policy ||
        previous.require?.join(',') !== snapshot.require?.join(','))
    ) {
      throw new MailError(
        'inbound_rejected',
        '@velajs/mail: the shared inbound gate changed between registrations',
      );
    }
    gates.set(source, snapshot);
  }
  if (gates.size > 1)
    throw new MailError(
      'inbound_rejected',
      '@velajs/mail: multiple inbound authentication gates are registered; select exactly one',
    );
  return gates.values().next().value ?? DEFAULT_INBOUND_GATE;
}

/** Structural values are available before options factories or lifecycle hooks run. */
export const MAIL_QUEUE_REGISTRATION = new InjectionToken<string>('vela:mail:queue-registration');

export function assertUniqueMailQueues(container: Container): void {
  const queues = new Set<string>();
  for (const name of container.resolveAll(MAIL_QUEUE_REGISTRATION)) {
    if (queues.has(name)) {
      throw new Error(
        `@velajs/mail: queue "${name}" belongs to multiple mail registrations; use distinct queue names`,
      );
    }
    queues.add(name);
  }
}
