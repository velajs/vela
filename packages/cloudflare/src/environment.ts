import { defineProvider, InjectionToken } from '@velajs/vela';
import type { Container } from '@velajs/vela/internal';

/** An application's native Workers environment, including bindings and secrets. */
export interface CloudflareEnvironment<T extends object> {
  /** Typed token used by @Inject and provider factories. */
  readonly token: InjectionToken<T>;
  /** The environment supplied by the current platform event or DO constructor. */
  readonly env: T;
}

/**
 * Register native bindings before provider factories or lifecycle hooks run.
 * No platform I/O is performed here; callers create applications inside an event.
 */
export function registerCloudflareEnvironment<T extends object>(
  container: Container,
  environment: CloudflareEnvironment<T>,
): void {
  container.register(defineProvider(environment.token, { useValue: environment.env }));
  container.markGlobalToken(environment.token);
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
