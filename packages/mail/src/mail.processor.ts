import { Inject, Injectable, Optional, type Type } from '@velajs/vela';
import { Process, Processor, type QueueJob } from '@velajs/vela/queue';
import { MailError } from './mail.error';
import {
  MAIL_OPTIONS,
  MAIL_QUEUE,
  MAIL_QUEUE_JOB,
  MAIL_TRANSPORT,
  type ResolvedMailOptions,
} from './mail.tokens';
import type { MailTransport } from './types';
import { reparseBuiltWire } from './wire';

/**
 * The queue consumer. It re-validates the untrusted dequeued wire back into a
 * fresh `BuiltMessage` (guards run a SECOND time, on dequeue) before handing it
 * to the transport — so the injection matrix is proven on the queue path
 * independently of the producer. A malformed payload throws, which the vela
 * dispatcher rethrows to the platform's retry/DLQ machinery.
 *
 * The `@Processor(queueName)` binding is fixed at class-definition time, so a
 * fresh processor class is minted per module registration. Distinct mailers
 * must use distinct queue names within one application.
 */
export function createMailSendProcessor(queueName: string): Type {
  @Processor(queueName)
  @Injectable()
  class MailSendProcessor {
    constructor(
      @Optional() @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport | undefined,
      @Inject(MAIL_OPTIONS) private readonly options: ResolvedMailOptions,
    ) {}

    @Process(MAIL_QUEUE_JOB)
    async handle(job: QueueJob<unknown>): Promise<void> {
      const built = reparseBuiltWire(job.data, this.options.limits);
      const transport = this.options.transport ?? this.transport;
      if (!transport) {
        throw new MailError(
          'no_transport',
          '@velajs/mail: no transport is configured for this mailer',
        );
      }
      await transport.deliver(built);
    }
  }

  return MailSendProcessor;
}

/** Standalone default-queue processor for custom wiring; MailModule creates its own. */
export const MailSendProcessor: Type = createMailSendProcessor(MAIL_QUEUE);
