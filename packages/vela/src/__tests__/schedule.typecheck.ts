import { SetMetadata, applyDecorators } from '../index';
import {
  Cron,
  Interval,
  parseCron,
  type CronInvocation,
  type CronOptions,
  type IntervalInvocation,
  type ScheduleDecorator,
  type ScheduleInvocation,
} from '../schedule';

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

/** A scheduled handler receives only its invocation; the decorators enforce it. */
export class ScheduledHandlers {
  @Cron('0 3 * * *', { dialect: 'cloudflare' })
  nightly(tick: CronInvocation): string {
    return tick.expression;
  }

  @Cron('0 4 * * *', { dialect: 'cloudflare' })
  either(tick: ScheduleInvocation): number {
    return tick.scheduledTime;
  }

  @Cron('0 5 * * *', { dialect: 'cloudflare' })
  async bare(): Promise<void> {}

  @Interval(60_000)
  poll(tick: IntervalInvocation): number {
    return tick.ms;
  }

  // @ts-expect-error A cron job no longer receives the platform event and environment.
  @Cron('0 6 * * *', { dialect: 'cloudflare' })
  legacy(event: { cron: string; scheduledTime: number }, env: Record<string, unknown>): void {
    void [event, env];
  }

  // @ts-expect-error A cron job's only parameter is its invocation.
  @Cron('0 7 * * *', { dialect: 'cloudflare' })
  wrong(expression: string): void {
    void expression;
  }

  // @ts-expect-error A cron job receives a cron invocation, not an interval one.
  @Cron('0 8 * * *', { dialect: 'cloudflare' })
  mismatched(tick: IntervalInvocation): void {
    void tick;
  }

  // @ts-expect-error An interval job receives an interval invocation, not a cron one.
  @Interval(1000)
  pollCron(tick: CronInvocation): void {
    void tick;
  }

  // @ts-expect-error An interval job receives only its invocation.
  @Interval(1000)
  pollTwice(tick: IntervalInvocation, extra: number): void {
    void [tick, extra];
  }
}

/** Typed schedule decorators compose with applyDecorators like any other decorator. */
const Nightly = (): ReturnType<typeof applyDecorators> =>
  applyDecorators(
    Cron('0 3 * * *', { dialect: 'cloudflare' }),
    SetMetadata('job', 'nightly'),
    Interval(60_000),
  );

export class ComposedScheduledHandlers {
  @Nightly()
  nightly(tick: ScheduleInvocation): number {
    return tick.scheduledTime;
  }
}

// As in NestJS, a composed decorator does not check the handler it decorates:
// a direct @Cron rejects this signature, the composition accepts it.
export class ComposedUncheckedHandlers {
  @Nightly()
  nightly(label: string): string {
    return label;
  }
}

// @ts-expect-error A plain function is not a decorator.
applyDecorators((label: string) => label);

// A typed decorator is narrower than the untyped MethodDecorator, which accepts any method.
// @ts-expect-error Type such a variable as ScheduleDecorator<CronInvocation> or let it infer.
export const untyped: MethodDecorator = Cron('0 9 * * *', { dialect: 'cloudflare' });
export const typed: ScheduleDecorator<CronInvocation> = Cron('0 9 * * *', {
  dialect: 'cloudflare',
});
