import { MailError } from '../../mail.error';
import type { Address, BuiltMessage, DeliveryResult, MailTransport } from '../../types';

// Workers types require a name on object addresses; bare addresses use the string form.
type CloudflareEmailAddress = string | Required<Address>;

/** The structured sending fields used by this transport, without native runtime imports. */
export type CloudflareEmailPayload = Pick<BuiltMessage, 'subject' | 'html' | 'text'> &
  Partial<Pick<BuiltMessage, 'headers'>> & {
    from: CloudflareEmailAddress;
    to: CloudflareEmailAddress[];
    cc?: CloudflareEmailAddress[];
    bcc?: CloudflareEmailAddress[];
    replyTo?: CloudflareEmailAddress;
  };

/** Structural subset of the native SendEmail binding's structured send overload. */
export interface CloudflareEmailBinding {
  send(message: CloudflareEmailPayload): Promise<unknown>;
}

export interface CloudflareEmailTransportOptions {
  /** The current application's native send_email binding. */
  binding: CloudflareEmailBinding;
}

function toAddress(address: Address): CloudflareEmailAddress {
  return address.name === undefined ? address.email : { email: address.email, name: address.name };
}

function toPayload(built: BuiltMessage): CloudflareEmailPayload {
  const payload: CloudflareEmailPayload = {
    from: toAddress(built.from),
    to: built.to.map(toAddress),
    subject: built.subject,
  };
  if (built.cc.length > 0) payload.cc = built.cc.map(toAddress);
  if (built.bcc.length > 0) payload.bcc = built.bcc.map(toAddress);
  if (built.replyTo !== undefined) payload.replyTo = toAddress(built.replyTo);
  if (built.html !== undefined) payload.html = built.html;
  if (built.text !== undefined) payload.text = built.text;
  if (Object.keys(built.headers).length > 0) payload.headers = { ...built.headers };
  return payload;
}

/**
 * Send a validated BuiltMessage through Cloudflare Email Service's structured
 * API. No Vela, SDK, raw MIME, retries, or shared environment state are needed.
 * A resolved send is a provider submission result, not proof of recipient delivery.
 * Provider failures retain their original code and details only in MailError.cause.
 */
export function cloudflareEmailTransport(options: CloudflareEmailTransportOptions): MailTransport {
  const binding = options.binding;
  return {
    async deliver(built: BuiltMessage): Promise<DeliveryResult> {
      // Count all entries, including duplicates across fields, as the native API does.
      // Never split a message: partial submissions make retries unsafe to reason about.
      if (built.to.length + built.cc.length + built.bcc.length > 50) {
        throw new MailError(
          'invalid_message',
          '@velajs/mail: Cloudflare Email Service accepts at most 50 recipients',
        );
      }
      const payload = toPayload(built);
      let result: unknown;
      try {
        // Preserve the receiver: native binding methods must be called on their binding.
        result = await binding.send(payload);
      } catch (cause) {
        throw new MailError('provider_error', '@velajs/mail: email delivery failed', {
          internal: true,
          cause,
        });
      }
      const id =
        typeof result === 'object' &&
        result !== null &&
        !Array.isArray(result) &&
        'messageId' in result &&
        typeof result.messageId === 'string' &&
        result.messageId.length > 0
          ? result.messageId
          : undefined;
      // Do not manufacture a retry after a fulfilled send just because tracking is absent.
      return id === undefined ? { provider: 'cloudflare' } : { id, provider: 'cloudflare' };
    },
  };
}
