import type { Container } from '../container/container';
import type { Entrypoint } from '../entrypoint/entrypoint.types';
import { getScopedComponents } from '../pipeline/scoped-components';
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

const COMPONENT_DECORATORS = [
  ['guard', '@UseGuards'],
  ['interceptor', '@UseInterceptors'],
  ['filter', '@UseFilters'],
] as const;

/**
 * Name the component decorators (`@UseGuards`, `@UseInterceptors`,
 * `@UseFilters`) that apply to a scheduled job's method through its class,
 * method or module, in that order. A direct scheduled job runs none of them,
 * so runtimes report a non-empty result through diagnostics.
 */
export function scheduledJobComponents(
  container: Container,
  entry: Entrypoint<{ readonly methodName: string }>,
): string[] {
  const target = entry.token;
  if (typeof target !== 'function') return [];
  return COMPONENT_DECORATORS.filter(
    ([kind]) =>
      getScopedComponents(kind, target, entry.meta.methodName, container, entry.moduleId).length >
      0,
  ).map(([, decorator]) => decorator);
}

/**
 * @internal The diagnostic for {@link scheduledJobComponents}: `label` names
 * the job (for example `@Cron('0 3 * * *') on Reports.nightly`).
 */
export function scheduledJobComponentsMessage(
  label: string,
  decorators: readonly string[],
): string {
  const named =
    decorators.length > 1
      ? `${decorators.slice(0, -1).join(', ')} and ${decorators.at(-1)!}`
      : decorators.join('');
  return (
    `[vela] ${label} declares ${named}, which do not run for scheduled jobs: a direct job ` +
    `runs no guards, interceptors or filters. Use signed ScheduleModule dispatch and declare ` +
    `them on the signed route to run the job through the request pipeline.`
  );
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
