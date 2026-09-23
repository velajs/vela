import type { Container } from '../container/container';
import type { CronMetadata } from './schedule.types';

/**
 * Explain why a cron declaration without a `dialect` would fire on different
 * days depending on the runtime, or return `undefined` when it cannot. Node
 * reads an undeclared dialect as Unix cron, while Cloudflare delivers the
 * trigger string with its own semantics: weekday numbers start at 0 = Sunday in
 * Unix cron and at 1 = Sunday on Cloudflare, and when both day fields are
 * restricted Unix cron requires both to match while Cloudflare accepts either.
 * Declaring `dialect` removes the ambiguity.
 */
export function cronDialectAmbiguity(
  meta: Pick<CronMetadata, 'expression' | 'dialect'>,
): string | undefined {
  if (meta.dialect !== undefined) return undefined;
  const fields = meta.expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [, , day, , weekday] = fields;
  if (weekday !== undefined && /\d/.test(weekday)) {
    return (
      'its weekday field uses numbers, which count from 0 = Sunday in Unix cron and from ' +
      '1 = Sunday on Cloudflare'
    );
  }
  if (day !== '*' && weekday !== '*') {
    return (
      'it restricts both day-of-month and weekday, which Unix cron requires together and ' +
      'Cloudflare accepts separately'
    );
  }
  return undefined;
}

const reported = new Set<string>();

/**
 * @internal Apply the diagnostics policy to a schedule declaration a runtime
 * cannot honor as written: `'throw'` fails the caller, `'log'` warns once per
 * message in this isolate, `'silent'` ignores it.
 */
export function reportScheduleDiagnostic(container: Container, message: string): void {
  const mode = container.getDiagnostics();
  if (mode === 'silent') return;
  if (mode === 'throw') throw new Error(message);
  if (reported.has(message)) return;
  reported.add(message);
  console.warn(message);
}

/** @internal Name a scheduled job the way diagnostics and reports do. */
export function scheduledJobName(token: unknown, methodName: string): string {
  return `${typeof token === 'function' ? token.name : String(token)}.${methodName}`;
}
