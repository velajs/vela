import { VelaError } from './error';

/** Throws an internal-coded VelaError — rich in server logs, redacted on the wire. */
export function invariant(condition: unknown, message: string, data?: unknown): asserts condition {
  if (!condition) {
    throw new VelaError('internal', { message: `Invariant violation: ${message}`, data });
  }
}

export function unreachable(value: never, message = 'unreachable code reached'): never {
  throw new VelaError('internal', { message, data: { value } });
}
