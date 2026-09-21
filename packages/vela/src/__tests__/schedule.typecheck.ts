import { Cron, parseCron, type ScheduleInvocation, type CronOptions } from '../schedule';

export function checkScheduleTypes(tick: ScheduleInvocation): void {
  const signal: AbortSignal = tick.signal;
  if (tick.kind === 'cron') {
    const expression: string = tick.expression;
    // @ts-expect-error An interval period is unavailable on a cron invocation.
    const interval: number = tick.ms;
    void [expression, interval];
  } else {
    const period: number = tick.ms;
    // @ts-expect-error A cron expression is unavailable on an interval invocation.
    const expression: string = tick.expression;
    void [period, expression];
  }
  const options: CronOptions = { dialect: 'cloudflare', timeZone: 'UTC' };
  parseCron('0 0 * * MON', options);
  Cron('* * * * *');
  // @ts-expect-error Only explicitly supported dialects can be authored.
  Cron('* * * * *', { dialect: 'quartz' });
  // @ts-expect-error Unsupported named zones are not silently accepted.
  parseCron('* * * * *', { timeZone: 'America/Sao_Paulo' });
  void signal;
}
