import { Inject, Injectable, Optional } from '@velajs/vela';
import { Container } from '@velajs/vela/module-kit';
import { queueToken } from '@velajs/vela/queue';
import { buildMessage } from './build';
import { MailError } from './mail.error';
import {
  MAIL_OPTIONS,
  MAIL_QUEUE_JOB,
  MAIL_TRANSPORT,
  type ResolvedMailOptions,
} from './mail.tokens';
import type { BuildOptions } from './build';
import type { DeliveryResult, MailMessage, MailTransport } from './types';

/**
 * The injectable producer. `send` builds (running every guard) and hands the
 * {@link import('./types').BuiltMessage} to the transport; `queue` builds and
 * enqueues the built message onto the configured vela queue — guards run BEFORE
 * enqueue, so a poisoned subject/address can never be queued.
 *
 * The transport is preferred from the mailer options, then the `@Optional`
 * {@link MAIL_TRANSPORT} token a transport module provides. The queue client is
 * resolved lazily through the app container from the one module that owns the
 * queue's `QueueClient` (`QueueModule.forFeature`, which the mailer imports
 * when `queue` is configured), so a mailer without a queue fails with
 * `queue_required` at first use rather than at bootstrap.
 */
@Injectable()
export class MailService {
  constructor(
    @Optional() @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport | undefined,
    @Inject(MAIL_OPTIONS) private readonly options: ResolvedMailOptions,
    @Inject(Container) private readonly container: Container,
  ) {}

  /** Build (guards run) then deliver via the configured transport. */
  async send(msg: MailMessage): Promise<DeliveryResult> {
    const built = await buildMessage(msg, this.buildOptions());
    const transport = this.options.transport ?? this.transport;
    if (!transport) {
      throw new MailError(
        'no_transport',
        '@velajs/mail: no transport is configured for this mailer',
      );
    }
    return transport.deliver(built);
  }

  /** Build (guards run) then enqueue the built message for a queue consumer. */
  async queue(msg: MailMessage): Promise<{ queued: true }> {
    const name = this.options.queueName;
    const token = name === undefined ? undefined : queueToken(name);
    if (token === undefined || !this.container.has(token)) {
      throw new MailError(
        'queue_required',
        '@velajs/mail: queueing requires a queue. Pass queue: { name?, binding? } to ' +
          'MailModule.register (the mailer registers that queue itself) and import ' +
          'QueueModule.forRoot({ driver }) once in the root module.',
      );
    }
    // One client module owns each queue name, however many modules register it.
    const owners = this.container.getOwnerModuleIds(token);
    if (owners.length !== 1) {
      throw new MailError(
        'queue_required',
        '@velajs/mail: the configured queue must have exactly one owner',
      );
    }
    const client = await this.container.resolveAsync(token, owners[0]);
    const built = await buildMessage(msg, this.buildOptions());
    await client.add(MAIL_QUEUE_JOB, built);
    return { queued: true };
  }

  private buildOptions(): BuildOptions {
    return this.options.render === undefined
      ? { from: this.options.from, limits: this.options.limits }
      : { from: this.options.from, render: this.options.render, limits: this.options.limits };
  }
}
