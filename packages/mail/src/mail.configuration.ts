import { InjectionToken } from '@velajs/vela';
import type { Container } from '@velajs/vela/module-kit';

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
