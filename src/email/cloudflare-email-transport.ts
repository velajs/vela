import { EmailMessage } from 'cloudflare:email';
import { MailError, renderRawMessage } from '@velajs/mail';
import type { BuiltMessage, DeliveryResult, MailTransport } from '@velajs/mail';
import type { BindingRef } from '../binding-ref';

/**
 * Build a {@link MailTransport} over a Cloudflare `send_email` binding
 * (`SendEmail`). Every injection guard has already run in `@velajs/mail`'s
 * `buildMessage`, so the {@link BuiltMessage} handed here is fully sanitized —
 * `renderRawMessage` assembles the RFC 822 bytes ABOVE this seam and nothing a
 * caller supplied can smuggle a header into the raw stream.
 *
 * The binding is read lazily from its {@link BindingRef} at `deliver` time (a
 * request), never at construction: the ref is populated by `createCloudflareApp`
 * middleware on the first request, mirroring how every other Cloudflare binding
 * is initialized.
 *
 * `cloudflare:email`'s `EmailMessage` carries a SINGLE envelope recipient, so a
 * multi-recipient message fans out to one `send` per envelope address; the
 * returned `id` joins each platform message id.
 */
export function createCloudflareEmailTransport(ref: BindingRef<SendEmail>): MailTransport {
  return {
    async deliver(message: BuiltMessage): Promise<DeliveryResult> {
      // Lazy read — the ref is initialized by the first request's middleware.
      const binding = ref.value;
      const ids: string[] = [];

      for (const recipient of message.envelope.to) {
        const raw = renderRawMessage({
          ...message,
          envelope: { from: message.envelope.from, to: [recipient] },
        });
        const email = new EmailMessage(message.envelope.from, recipient, raw);
        try {
          const result: EmailSendResult = await binding.send(email);
          ids.push(result.messageId);
        } catch (cause) {
          // Redact: the platform error may carry recipient/content detail. The
          // raw cause rides `MailError.cause` for server-side logging only; the
          // thrown `.message` stays the fixed, client-safe string.
          throw new MailError('provider_error', '@velajs/mail: email delivery failed', {
            internal: true,
            cause,
          });
        }
      }

      const delivery: DeliveryResult = { provider: 'cloudflare' };
      if (ids.length > 0) delivery.id = ids.join(',');
      return delivery;
    },
  };
}
