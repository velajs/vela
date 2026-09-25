import { MailError } from '../mail.error';
import {
  DEFAULT_INBOUND_MAIL_LIMITS,
  parseInboundEmail,
  type InboundEmail,
  type ParseInboundEmailOptions,
} from './parse';

/**
 * The inbound message an email platform hands a Worker: its SMTP envelope
 * (`from`, `to`), the raw RFC 5322 message as a stream, and its declared
 * size. Cloudflare's `ForwardableEmailMessage`, which `@OnEmail()` handlers of
 * `@velajs/cloudflare/email` receive, has this shape.
 */
export interface InboundEmailMessage {
  /** The envelope sender (`MAIL FROM`). */
  readonly from: string;
  /** The envelope recipient (`RCPT TO`). */
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  /** The size the platform declares for `raw`, checked before it is read. */
  readonly rawSize?: number;
}

/** Options of {@link readInboundEmail}: the parse options, less the envelope the message carries. */
export type ReadInboundEmailOptions = Omit<ParseInboundEmailOptions, 'envelope'>;

function tooLarge(limit: number): MailError {
  return new MailError(
    'inbound_malformed',
    `@velajs/mail: inbound message exceeds the ${limit}-byte limit`,
  );
}

/** Read `stream` whole, cancelling it once it passes `limit` bytes. */
async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- A stream is read chunk by chunk.
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        // eslint-disable-next-line no-await-in-loop -- Cancelled once, then the loop ends.
        await reader.cancel().catch(() => {});
        throw tooLarge(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Read a platform inbound message, such as an Email Workers message, into an
 * {@link InboundEmail}. The raw stream is read up to `limits.maxMessageBytes`
 * (a larger declared `rawSize` is refused before reading; a longer stream is
 * cancelled), then parsed by {@link parseInboundEmail} with the SMTP envelope
 * as the message's envelope. Its authentication stays unverified unless
 * `verifiedAuthentication` or `trustedAuthservIds` says otherwise, so the
 * default gate refuses it: supply verdicts only from a source you trust.
 *
 * ```ts
 * @OnEmail({ to: 'support@example.com' })
 * async receive(message: ForwardableEmailMessage): Promise<void> {
 *   const email = await readInboundEmail(message);
 *   await this.tickets.open(email.envelope?.from, email.subject);
 * }
 * ```
 */
export async function readInboundEmail(
  message: InboundEmailMessage,
  options: ReadInboundEmailOptions = {},
): Promise<InboundEmail> {
  const limit = options.limits?.maxMessageBytes ?? DEFAULT_INBOUND_MAIL_LIMITS.maxMessageBytes;
  if (typeof message.rawSize === 'number' && message.rawSize > limit) {
    await message.raw.cancel().catch(() => {});
    throw tooLarge(limit);
  }
  const raw = await readBounded(message.raw, limit);
  return parseInboundEmail(raw, { ...options, envelope: { from: message.from, to: message.to } });
}
