import {
  cronDialectAmbiguity,
  parseCronMetadata,
  parseIntervalMetadata,
  scheduledJobComponents,
} from '@velajs/vela/module-kit';
import type { VelaApplication } from '@velajs/vela';
import type { Entrypoint, Container } from '@velajs/vela/module-kit';

const reported = new Set<string>();

/** `'throw'` fails the caller, `'log'` warns once per message in this isolate. */
function reportScheduleDiagnostic(container: Container, message: string): void {
  const mode = container.getDiagnostics();
  if (mode === 'silent') return;
  if (mode === 'throw') throw new Error(message);
  if (reported.has(message)) return;
  reported.add(message);
  console.warn(message);
}

function jobName(entry: Entrypoint<{ methodName: string }>): string {
  const owner = typeof entry.token === 'function' ? entry.token.name : String(entry.token);
  return `${owner}.${entry.meta.methodName}`;
}

/**
 * Guards, interceptors and filters declared for a job never run on its
 * trigger, and a direct job that declares guards is refused on every trigger.
 */
function reportComponents(
  container: Container,
  label: string,
  entry: Entrypoint<{ methodName: string }>,
): void {
  const decorators = scheduledJobComponents(container, entry);
  if (decorators.length === 0) return;
  const named =
    decorators.length > 1
      ? `${decorators.slice(0, -1).join(', ')} and ${decorators.at(-1)!}`
      : decorators.join('');
  const refused = decorators.includes('@UseGuards')
    ? ', and one that declares guards refuses to run'
    : '';
  reportScheduleDiagnostic(
    container,
    `[vela] ${label} declares ${named}, which do not run for scheduled jobs: a direct job ` +
      `runs no guards, interceptors or filters${refused}. Use signed ScheduleModule dispatch ` +
      `and declare them on the signed route to run the job through the request pipeline.`,
  );
}

/**
 * Report schedule declarations a Workers cron trigger cannot honor as written:
 * a dialect-ambiguous `@Cron`, `dialect: 'unix'`, `timeZone: 'local'`,
 * `@Interval` jobs, and guards, interceptors or filters declared for a job
 * (a direct job that declares guards is refused when it fires).
 * The container's diagnostics policy applies: `'throw'` fails bootstrap and the
 * default `'log'` warns once per declaration, so the first event of a Worker
 * (which bootstraps the application) never fails because of these checks.
 * `vela deploy check` rejects the cron declarations, `@Interval` jobs and
 * guarded direct jobs before deployment (`ambiguous-cron-dialect`,
 * `incompatible-cron-options`, `unsupported-interval`, `scheduled-job-guards`).
 */
export function reportCloudflareScheduleDiagnostics(
  container: Container,
  entrypoints: VelaApplication['entrypoints'],
): void {
  for (const entry of entrypoints.ofKind('schedule:cron', parseCronMetadata)) {
    const cron = `@Cron('${entry.meta.expression}') on ${jobName(entry)}`;
    const ambiguity = cronDialectAmbiguity(entry.meta);
    if (ambiguity) {
      reportScheduleDiagnostic(
        container,
        `[vela] ${cron} declares no dialect, and ${ambiguity}. Workers deliver the trigger ` +
          `with Cloudflare semantics while Node reads it with Vela's unix dialect; declare ` +
          `{ dialect: 'cloudflare' } so it fires on the same days on every runtime.`,
      );
    }
    if (entry.meta.dialect === 'unix') {
      reportScheduleDiagnostic(
        container,
        `[vela] ${cron} declares dialect 'unix', but Cloudflare delivers its trigger with ` +
          `Cloudflare cron semantics (weekdays 1 = Sunday through 7 = Saturday). Declare ` +
          `{ dialect: 'cloudflare' } and write the expression for Cloudflare.`,
      );
    }
    if (entry.meta.timeZone === 'local') {
      reportScheduleDiagnostic(
        container,
        `[vela] ${cron} declares timeZone 'local', but Cloudflare cron triggers run in UTC. ` +
          `Remove timeZone or set it to 'UTC'.`,
      );
    }
    reportComponents(container, cron, entry);
  }
  for (const entry of entrypoints.ofKind('schedule:interval', parseIntervalMetadata)) {
    reportScheduleDiagnostic(
      container,
      `[vela] @Interval(${entry.meta.ms}) on ${jobName(entry)} never runs on Workers: cron ` +
        `triggers drive only @Cron jobs. Replace it with a @Cron job and a Wrangler trigger, ` +
        `or run it under ScheduleNodeModule on Node.`,
    );
  }
}
