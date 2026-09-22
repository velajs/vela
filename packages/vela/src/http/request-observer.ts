import type { Container } from '../container/container';
import type { VelaContext } from './hono.types';

/** Completion of the response body, managed work, and request-scope disposal. */
export interface HttpRequestCompletion {
  /** Undefined when finalization failed before the response reached the transport. */
  readonly status: number | undefined;
  /** Registered route pattern; never the concrete request URL. */
  readonly route: string | undefined;
  readonly outcome: 'success' | 'error' | 'cancelled';
  readonly durationMs: number;
}

export interface HttpRequestObservation {
  /** Synchronous notification; failures are contained by the HTTP lifecycle. */
  complete(completion: HttpRequestCompletion): void;
}

/** Application-owned observer, called before input validation and user middleware. */
export type HttpRequestObserver = (
  context: VelaContext,
  container: Container,
) => HttpRequestObservation | undefined;
