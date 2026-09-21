import { InjectionToken } from '@velajs/vela';
import type { MailInboundGate } from './inbound/gate';
import type { MailLimits } from './limits';
import type { AddressInput, MailTransport, RenderSeam } from './types';

/**
 * The active outbound transport. `MailModule` folds an explicitly-passed
 * transport into {@link MAIL_OPTIONS}; an application-authored transport module instead provides THIS token, which `MailService` resolves
 * `@Optional`ly. A missing transport throws `no_transport` at first use, never
 * at bootstrap.
 */
export const MAIL_TRANSPORT = new InjectionToken<MailTransport>('vela:mail:transport');

/**
 * The app-level inbound gate. Contributed as a GLOBAL token (the
 * `ScheduleModule.SCHEDULE_DISPATCH` pattern) so the inbound dispatcher — which
 * the Cloudflare email host hook invokes from a different module — can read it.
 * Absent ⇒ {@link import('./inbound/gate').DEFAULT_INBOUND_GATE}.
 */
export const MAIL_INBOUND_GATE = new InjectionToken<MailInboundGate>('vela:mail:inbound-gate');

/** The resolved mailer options `MailService`/`MailSendProcessor` read. */
export interface ResolvedMailOptions {
  from: AddressInput;
  render?: RenderSeam;
  /**
   * A transport passed directly to the mailer (`forRoot`/`forRootAsync`). When
   * absent, the transport is resolved from the {@link MAIL_TRANSPORT} token that
   * an application-authored transport module provides.
   */
  transport?: MailTransport;
  /** Name of the vela queue used by `MailService.queue()`, when configured. */
  queueName?: string;
  limits: MailLimits;
}

export const MAIL_OPTIONS = new InjectionToken<ResolvedMailOptions>('vela:mail:options');

/** Metadata key backing the `mail:inbound` entrypoint kind. */
export const MAIL_INBOUND_METADATA = 'vela:mail:inbound';

/** Job name for queue-backed sends. */
export const MAIL_QUEUE_JOB = 'mail:send';

/** Default name of the vela queue used for mail sends. */
export const MAIL_QUEUE = 'mail';
