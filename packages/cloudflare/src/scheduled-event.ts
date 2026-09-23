import { InjectionToken, SCHEDULE_INVOCATION_SEED, Scope, defineProvider } from '@velajs/vela';
import type { ScheduleInvocationSeed } from '@velajs/vela';
import type { Container } from '@velajs/vela/internal';

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
 * @internal Register the request-scoped placeholder so jobs can depend on the
 * token; each scheduled invocation seeds the real value into its own scope.
 * Also provides `SCHEDULE_INVOCATION_SEED`, so jobs fired on demand get a
 * synthetic event.
 */
export function registerCloudflareScheduledEvent(container: Container): void {
  container.register(
    defineProvider(CLOUDFLARE_SCHEDULED_EVENT, {
      inject: [],
      scope: Scope.REQUEST,
      useFactory: () => {
        throw new Error(
          'CLOUDFLARE_SCHEDULED_EVENT can only be resolved inside a scheduled invocation: ' +
            'the Cloudflare adapter seeds it into each @Cron job scope for a cron trigger.',
        );
      },
    }),
  );
  container.markGlobalToken(CLOUDFLARE_SCHEDULED_EVENT);
  container.register(defineProvider(SCHEDULE_INVOCATION_SEED, { useValue: seedScheduledEvent }));
  container.markGlobalToken(SCHEDULE_INVOCATION_SEED);
}
