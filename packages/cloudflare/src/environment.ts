import { defineProvider, ENV } from '@velajs/vela';
import type { VelaEnv } from '@velajs/vela';
import type { Container } from '@velajs/vela/internal';

/**
 * Seed the application's native environment as the global ENV before provider
 * factories or lifecycle hooks run. No platform I/O is performed here; callers
 * create applications inside an event or a Durable Object constructor.
 */
export function registerCloudflareEnvironment(container: Container, env: VelaEnv): void {
  container.register(defineProvider(ENV, { useValue: env }));
  container.markGlobalToken(ENV);
}

/** Reject accidental reuse of an application with another event's environment. */
export function assertCloudflareEnvironment<T extends object>(expected: T, actual: T): void {
  if (actual !== expected) {
    throw new Error(
      'This Cloudflare application belongs to a different environment. ' +
        'Create an application with the current event environment.',
    );
  }
}
