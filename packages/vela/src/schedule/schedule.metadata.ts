import { parseCron } from './cron-matcher';
import type { CronMetadata, IntervalMetadata } from './schedule.types';

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') throw new TypeError('Invalid schedule metadata');
  return value as Record<string, unknown>;
}

/** Validate metadata shape without assuming which runtime will execute a bare @Cron. */
export function parseCronMetadata(value: unknown): CronMetadata {
  const meta = record(value);
  if (
    typeof meta.expression !== 'string' ||
    !meta.expression.trim() ||
    typeof meta.methodName !== 'string'
  ) {
    throw new TypeError('Cron metadata requires an expression and methodName');
  }
  const result: CronMetadata = { expression: meta.expression, methodName: meta.methodName };
  if (meta.dialect !== undefined) {
    if (meta.dialect !== 'unix' && meta.dialect !== 'cloudflare')
      throw new TypeError('Invalid cron dialect');
    result.dialect = meta.dialect;
  }
  if (meta.timeZone !== undefined) {
    if (meta.timeZone !== 'local' && meta.timeZone !== 'UTC')
      throw new TypeError('Invalid cron timeZone');
    result.timeZone = meta.timeZone;
  }
  if (
    (result.dialect !== undefined || result.timeZone !== undefined) &&
    !parseCron(result.expression, result)
  ) {
    throw new TypeError(`Invalid cron expression or options: ${result.expression}`);
  }
  return result;
}

/** Reject timer coercion/overflow rather than accidentally scheduling a 1 ms loop. */
export function parseIntervalMetadata(value: unknown): IntervalMetadata {
  const meta = record(value);
  if (
    typeof meta.ms !== 'number' ||
    !Number.isInteger(meta.ms) ||
    meta.ms < 1 ||
    meta.ms > 2_147_483_647 ||
    typeof meta.methodName !== 'string'
  ) {
    throw new TypeError(
      'Interval metadata requires integer ms between 1 and 2147483647 and a methodName',
    );
  }
  return { ms: meta.ms, methodName: meta.methodName };
}
