import { InjectionToken, Scope, defineProvider } from '@velajs/vela';
import { SCHEDULE_INVOCATION_SEED } from '@velajs/vela/module-kit';
import type { ScheduleInvocationSeed, Container } from '@velajs/vela/module-kit';

/**
 * The event a Worker's `scheduled()` export receives. The native
 * `ScheduledController` satisfies it; direct calls (tests, scripts) may omit
 * `scheduledTime`, which then defaults to the current time, and `noRetry`.
 */
export interface ScheduledEvent {
  readonly cron: string;
  readonly scheduledTime?: number;
  noRetry?(): void;
}

/** The Cloudflare trigger behind the current scheduled invocation. */
export interface CloudflareScheduledEvent {
  /** The trigger's exact cron string; it equals the invocation's `expression`. */
  readonly cron: string;
  /** The platform's scheduled time in Unix milliseconds. */
  readonly scheduledTime: number;
  /**
   * Ask Cloudflare not to retry this trigger if the invocation fails. Already
   * bound to the native controller, so it can be passed around or destructured.
   * A no-op for direct calls that supplied no controller.
   */
  readonly noRetry: () => void;
}

/**
 * Request-scoped Cloudflare view of the scheduled trigger, seeded into each
 * `@Cron` job's invocation scope by the Cloudflare adapter. Inject it where a
 * job needs platform controls such as `noRetry()`; the job's argument stays
 * the portable `ScheduleInvocation`. It resolves only inside a scheduled
 * invocation; resolving it anywhere else throws. A cron job fired on demand
 * (Studio's run-now) receives a synthetic event: `cron` is the job's
 * expression and `noRetry()` does nothing.
 *
 * The token provides itself as request-scoped in every container, so a class
 * that injects it is request-scoped wherever the graph boots (a Worker, a
 * Durable Object, the CLI or a testing module) and is built only for an
 * invocation, never at bootstrap.
 *
 * @example
 * ```ts
 * @Injectable({ scope: Scope.REQUEST })
 * class Reports {
 *   constructor(@Inject(CLOUDFLARE_SCHEDULED_EVENT) private readonly trigger: CloudflareScheduledEvent) {}
 *
 *   @Cron('0 3 * * *', { dialect: 'cloudflare' })
 *   async nightly(tick: CronInvocation) {
 *     if (!(await this.upstreamAvailable(tick.signal))) this.trigger.noRetry();
 *   }
 * }
 * ```
 */
export const CLOUDFLARE_SCHEDULED_EVENT = new InjectionToken<CloudflareScheduledEvent>(
  '@velajs/cloudflare:scheduled-event',
  {
    scope: Scope.REQUEST,
    factory: () => {
      throw new Error(
        'CLOUDFLARE_SCHEDULED_EVENT can only be resolved inside a scheduled invocation: ' +
          'the Cloudflare adapter seeds it into each @Cron job scope for a cron trigger.',
      );
    },
  },
);

/** @internal Freeze the injected view; `noRetry` keeps the native receiver. */
export function cloudflareScheduledEvent(
  event: ScheduledEvent,
  scheduledTime: number,
): CloudflareScheduledEvent {
  return Object.freeze({
    cron: event.cron,
    scheduledTime,
    noRetry: () => {
      event.noRetry?.();
    },
  });
}

/**
 * Seeds a cron job fired outside a trigger (Studio's run-now) the way a
 * trigger would: a synthetic event whose `cron` is the invocation's
 * expression, with its `scheduledTime` and a `noRetry()` that does nothing.
 * Interval jobs never run from Workers triggers, so they get no event.
 */
const seedScheduledEvent: ScheduleInvocationSeed = (scope, invocation) => {
  if (invocation.kind !== 'cron') return;
  scope.setRequestInstance(
    CLOUDFLARE_SCHEDULED_EVENT,
    cloudflareScheduledEvent({ cron: invocation.expression }, invocation.scheduledTime),
  );
};

/**
 * @internal Provide `SCHEDULE_INVOCATION_SEED`, so jobs fired on demand get a
 * synthetic event. Each trigger seeds the real event into its jobs' scopes.
 */
export function registerScheduledEventSeed(container: Container): void {
  container.register(defineProvider(SCHEDULE_INVOCATION_SEED, { useValue: seedScheduledEvent }));
  container.markGlobalToken(SCHEDULE_INVOCATION_SEED);
}
