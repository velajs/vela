import { cronDialectAmbiguity, parseCronMetadata, parseIntervalMetadata } from '@velajs/vela';
import type { Entrypoint, VelaApplication } from '@velajs/vela';
import type { Container } from '@velajs/vela/internal';

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
 * Report schedule declarations a Workers cron trigger cannot honor as written.
 * The container's diagnostics policy applies: `'throw'` fails bootstrap and the
 * default `'log'` warns once per declaration, so the first event of a Worker
 * (which bootstraps the application) never fails because of these checks.
 * `vela deploy check` remains the gate that rejects them before deployment.
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
          `with Cloudflare semantics while Node reads it as Unix cron; declare ` +
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
